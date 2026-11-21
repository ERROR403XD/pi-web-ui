import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installLocalDeviceCenter,
	isLocalPeerAllowed,
	parseLocalProxyPeers,
} from "../../server/device-center/local.js";

/**
 * 设备中心在 Docker 反代（1Panel OpenResty 等）后面的对端判定。
 *
 * 真实回归：反代容器（如 172.18.0.3）与内核不在同一网络命名空间，到达内核的对端不是回环；
 * 只设 PI_WEB_ALLOW_HOSTS 时 Host 校验能过，但 localOnly 先按对端拒绝，
 * `/api/device-center/{status,rooms,local-bots,local-bot-options}` 经域名访问全部 403 LOCAL_ONLY。
 * 例外只给 PI_WEB_LOCAL_PROXY_PEERS 点名的地址，Host 与写请求同源校验保持不变。
 */

const PEER_HEADER = "x-test-remote-address";
const PROXY = "172.18.0.3";
const DOMAIN = "pi.example.test";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe("parseLocalProxyPeers / isLocalPeerAllowed", () => {
	it("loopback is always allowed, even without proxy peers", () => {
		const none = parseLocalProxyPeers(undefined);
		expect(isLocalPeerAllowed("127.0.0.1", none)).toBe(true);
		expect(isLocalPeerAllowed("127.8.0.1", none)).toBe(true);
		expect(isLocalPeerAllowed("::1", none)).toBe(true);
		expect(isLocalPeerAllowed("::ffff:127.0.0.1", none)).toBe(true);
		expect(isLocalPeerAllowed(undefined, none)).toBe(false);
		expect(isLocalPeerAllowed(PROXY, none)).toBe(false);
	});

	it("accepts comma separated entries and matches each peer exactly", () => {
		const peers = parseLocalProxyPeers([` ${PROXY} , fd00::3,`]);
		expect([...peers]).toEqual([PROXY, "fd00::3"]);
		expect(isLocalPeerAllowed(PROXY, peers)).toBe(true);
		expect(isLocalPeerAllowed(`::ffff:${PROXY}`, peers)).toBe(true);
		expect(isLocalPeerAllowed("FD00::3", peers)).toBe(true);
		expect(isLocalPeerAllowed("172.18.0.4", peers)).toBe(false);
		expect(isLocalPeerAllowed("172.18.0.30", peers)).toBe(false);
		expect(isLocalPeerAllowed("192.168.1.10", peers)).toBe(false);
	});

	it("drops CIDR, wildcard and hostname entries instead of widening the match", () => {
		const peers = parseLocalProxyPeers(["172.18.0.0/16", "172.18.*", "*", "openresty", "0.0.0.0/0"]);
		expect(peers.size).toBe(0);
		expect(isLocalPeerAllowed(PROXY, peers)).toBe(false);
	});
});

describe("device center behind a Docker reverse proxy (PI_WEB_LOCAL_PROXY_PEERS)", () => {
	async function boot(options: { allowHosts?: string[]; allowOrigins?: string[]; localProxyPeers?: string[] } = {}) {
		const dataDir = await mkdtemp(join(tmpdir(), "device-proxy-peer-"));
		cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
		const app = express();
		app.use((req, _res, next) => {
			const peer = req.headers[PEER_HEADER];
			if (typeof peer === "string")
				Object.defineProperty(req.socket, "remoteAddress", { value: peer, configurable: true });
			next();
		});
		app.use(express.json());
		const local = await installLocalDeviceCenter({ app, dataDir, ...options, connect: () => ({ close() {} }) });
		cleanup.push(() => local.close());
		const server: Server = createServer(app);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	}

	function call(
		base: string,
		options: { path: string; host: string; peer?: string; method?: string; origin?: string; body?: unknown },
	) {
		return new Promise<{ status: number; body: any }>((resolve, reject) => {
			const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
			const outgoing = httpRequest(
				`${base}/api/device-center/${options.path}`,
				{
					method: options.method ?? "GET",
					headers: {
						Host: options.host,
						...(options.peer === undefined ? {} : { [PEER_HEADER]: options.peer }),
						...(options.origin === undefined ? {} : { Origin: options.origin }),
						...(payload === undefined ? {} : { "Content-Type": "application/json" }),
					},
				},
				(incoming) => {
					let data = "";
					incoming.setEncoding("utf8");
					incoming.on("data", (chunk) => {
						data += chunk;
					});
					incoming.on("end", () => {
						let parsed: any = data;
						try {
							parsed = JSON.parse(data);
						} catch {}
						resolve({ status: incoming.statusCode ?? 0, body: parsed });
					});
				},
			);
			outgoing.on("error", reject);
			if (payload !== undefined) outgoing.write(payload);
			outgoing.end();
		});
	}

	const productionRoutes = ["status", "rooms", "local-bots", "local-bot-options"];
	const peerDenied = { code: "LOCAL_ONLY", error: "Configure devices from this computer's loopback address" };

	it("reproduces the regression: allow host alone still rejects the proxy container peer", async () => {
		const base = await boot({ allowHosts: [DOMAIN] });
		for (const path of productionRoutes) {
			const res = await call(base, { path, host: DOMAIN, peer: PROXY });
			expect(res.status, path).toBe(403);
			expect(res.body, path).toMatchObject(peerDenied);
		}
	});

	it("serves the production routes through a declared proxy peer + allow host", async () => {
		const base = await boot({ allowHosts: [DOMAIN], localProxyPeers: [PROXY] });
		for (const path of productionRoutes) {
			const res = await call(base, { path, host: DOMAIN, peer: PROXY });
			expect(res.status, path).toBe(200);
		}
		expect((await call(base, { path: "status", host: DOMAIN, peer: `::ffff:${PROXY}` })).status).toBe(200);
	});

	it("still rejects peers that are not declared", async () => {
		const base = await boot({ allowHosts: [DOMAIN], localProxyPeers: [PROXY] });
		for (const peer of ["172.18.0.4", "172.18.0.1", "192.168.1.20", "100.64.0.7"]) {
			const res = await call(base, { path: "status", host: DOMAIN, peer });
			expect(res.status, peer).toBe(403);
			expect(res.body, peer).toMatchObject(peerDenied);
		}
	});

	it("keeps the Host allowlist: a declared peer with an undeclared Host is rejected", async () => {
		const base = await boot({ allowHosts: [DOMAIN], localProxyPeers: [PROXY] });
		const denied = await call(base, { path: "status", host: "evil.example.com", peer: PROXY });
		expect(denied.status).toBe(403);
		expect(denied.body).toMatchObject({ code: "LOCAL_ONLY", error: "Use localhost to configure device access" });
		const noAllowHosts = await boot({ localProxyPeers: [PROXY] });
		const deniedDomain = await call(noAllowHosts, { path: "status", host: DOMAIN, peer: PROXY });
		expect(deniedDomain.status).toBe(403);
		expect(deniedDomain.body).toMatchObject({ code: "LOCAL_ONLY", error: "Use localhost to configure device access" });
	});

	it("keeps same-origin writes through the proxy peer, honouring PI_WEB_ALLOW_ORIGINS", async () => {
		const base = await boot({
			allowHosts: [DOMAIN],
			allowOrigins: ["https://console.example.test"],
			localProxyPeers: [PROXY],
		});
		const write = (origin: string) =>
			call(base, { path: "pair", host: DOMAIN, peer: PROXY, method: "POST", origin, body: {} });
		const sameOrigin = await write(`https://${DOMAIN}`);
		expect(sameOrigin.status).toBe(400);
		expect(sameOrigin.body.error).toBe("Invalid hub URL");
		const declared = await write("https://console.example.test");
		expect(declared.status).toBe(400);
		const crossOrigin = await write("https://evil.example.com");
		expect(crossOrigin.status).toBe(403);
		expect(crossOrigin.body).toMatchObject({ code: "LOCAL_ONLY", error: "Same-origin request required" });
		const optionsCross = await call(base, {
			path: "local-bot-options",
			host: DOMAIN,
			peer: PROXY,
			origin: "https://evil.example.com",
		});
		expect(optionsCross.status).toBe(403);
	});

	it("keeps loopback behaviour unchanged with or without proxy peers", async () => {
		for (const localProxyPeers of [undefined, [PROXY]]) {
			const base = await boot({ localProxyPeers });
			const loopback = new URL(base).host;
			expect((await call(base, { path: "status", host: loopback })).status).toBe(200);
			expect((await call(base, { path: "status", host: loopback, peer: "::1" })).status).toBe(200);
			const denied = await call(base, { path: "status", host: DOMAIN });
			expect(denied.status).toBe(403);
			expect(denied.body).toMatchObject({ code: "LOCAL_ONLY", error: "Use localhost to configure device access" });
		}
	});
});
