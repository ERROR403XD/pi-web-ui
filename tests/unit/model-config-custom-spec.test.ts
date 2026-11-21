// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppSend } from "../../web/src/app-globals.js";
import { ModelConfigModal } from "../../web/src/components/ModelConfigModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";

type ModalProps = Parameters<typeof ModelConfigModal>[0];
let root: Root | null = null;

const magpieProvider = {
	providerId: "magpie",
	name: "Magpie",
	api: "openai-completions",
	baseUrl: "https://magpie.example.test/v1",
	authHeader: true,
	models: [
		{ id: "ciallo/claude-opus-5-5", contextWindow: 400000, maxTokens: 128000 },
		{ id: "preset-model", name: "Preset Model", contextWindow: 131072, maxTokens: 8192 },
	],
};

function mount(providers: ModalProps["providers"] = [magpieProvider]) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const sent: any[] = [];
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	root = createRoot(container);
	const props: ModalProps = {
		providers,
		providerStatus: [],
		providerKeys: {},
		providerOAuthFlows: [],
		providerOAuthResults: {},
		onClose: () => {},
	};
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(ModelConfigModal, props)));
	});
	return { container, sent };
}

function spec(container: HTMLElement, row: number, field: "ctx" | "max") {
	const card = container.querySelectorAll(".model-matrix-card")[row] as HTMLElement;
	const box = card.querySelectorAll(".spec-combobox")[field === "ctx" ? 0 : 1] as HTMLElement;
	return {
		select: box.querySelector("select") as HTMLSelectElement,
		input: box.querySelector(".spec-combobox-custom-input") as HTMLInputElement | null,
	};
}

function choose(select: HTMLSelectElement, value: string) {
	act(() => {
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function save(container: HTMLElement, sent: any[]) {
	const button = container.querySelector(".studio-card-head .btn.primary.sm") as HTMLButtonElement;
	act(() => button.click());
	const message = sent.find((m) => m.type === "save_model_config");
	expect(message).toBeDefined();
	return JSON.parse(JSON.stringify(message));
}

function savedModels(wire: any): any[] {
	return wire.config.models;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	setAppSend(null);
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("model config custom context window / max output", () => {
	it("shows preset values as presets without a custom input", () => {
		const { container } = mount();
		const ctx = spec(container, 1, "ctx");
		const max = spec(container, 1, "max");
		expect(ctx.select.value).toBe("131072");
		expect(ctx.input).toBeNull();
		expect(max.select.value).toBe("8192");
		expect(max.input).toBeNull();
	});

	it("opens existing non-preset values in custom mode and keeps the values", () => {
		const { container } = mount();
		const ctx = spec(container, 0, "ctx");
		const max = spec(container, 0, "max");
		expect(ctx.select.value).toBe("custom");
		expect(ctx.input?.value).toBe("400000");
		expect(max.select.value).toBe("custom");
		expect(max.input?.value).toBe("128000");
	});

	it("shows an editable input immediately after choosing custom, independently per field", () => {
		const { container, sent } = mount();

		choose(spec(container, 1, "ctx").select, "custom");
		expect(spec(container, 1, "ctx").select.value).toBe("custom");
		expect(spec(container, 1, "ctx").input?.value).toBe("131072");
		expect(spec(container, 1, "max").select.value).toBe("8192");
		expect(spec(container, 1, "max").input).toBeNull();

		type(spec(container, 1, "ctx").input!, "400000");
		expect(spec(container, 1, "ctx").input?.value).toBe("400000");
		expect(spec(container, 1, "max").input).toBeNull();

		choose(spec(container, 1, "max").select, "custom");
		expect(spec(container, 1, "max").input?.value).toBe("8192");
		type(spec(container, 1, "max").input!, "128000");

		const models = savedModels(save(container, sent));
		expect(models[1]).toEqual({ id: "preset-model", name: "Preset Model", contextWindow: 400000, maxTokens: 128000 });
	});

	it("keeps custom mode when the typed value equals a preset", () => {
		const { container } = mount();
		choose(spec(container, 0, "ctx").select, "custom");
		type(spec(container, 0, "ctx").input!, "131072");
		expect(spec(container, 0, "ctx").select.value).toBe("custom");
		expect(spec(container, 0, "ctx").input?.value).toBe("131072");
	});

	it("restores preset state and value when a preset is chosen again", () => {
		const { container, sent } = mount();

		choose(spec(container, 1, "ctx").select, "custom");
		choose(spec(container, 1, "ctx").select, "200000");
		expect(spec(container, 1, "ctx").select.value).toBe("200000");
		expect(spec(container, 1, "ctx").input).toBeNull();

		choose(spec(container, 0, "max").select, "16384");
		expect(spec(container, 0, "max").select.value).toBe("16384");
		expect(spec(container, 0, "max").input).toBeNull();
		expect(spec(container, 0, "ctx").select.value).toBe("custom");
		expect(spec(container, 0, "ctx").input?.value).toBe("400000");

		const models = savedModels(save(container, sent));
		expect(models[0]).toEqual({ id: "ciallo/claude-opus-5-5", contextWindow: 400000, maxTokens: 16384 });
		expect(models[1]).toEqual({ id: "preset-model", name: "Preset Model", contextWindow: 200000, maxTokens: 8192 });
	});

	it("edits an existing non-preset value and saves the number", () => {
		const { container, sent } = mount();
		type(spec(container, 0, "ctx").input!, "1048576");
		type(spec(container, 0, "max").input!, "65000");
		const models = savedModels(save(container, sent));
		expect(models[0]).toEqual({ id: "ciallo/claude-opus-5-5", contextWindow: 1048576, maxTokens: 65000 });
	});

	it("saves an untouched provider in the legacy payload format without UI-only flags", () => {
		const { container, sent } = mount();
		choose(spec(container, 1, "ctx").select, "custom");
		choose(spec(container, 1, "ctx").select, "131072");
		const wire = save(container, sent);
		expect(wire).toEqual({
			type: "save_model_config",
			providerId: "magpie",
			config: {
				providerId: "magpie",
				name: "Magpie",
				api: "openai-completions",
				baseUrl: "https://magpie.example.test/v1",
				authHeader: true,
				models: [
					{ id: "ciallo/claude-opus-5-5", contextWindow: 400000, maxTokens: 128000 },
					{ id: "preset-model", name: "Preset Model", contextWindow: 131072, maxTokens: 8192 },
				],
			},
		});
		expect(JSON.stringify(wire)).not.toMatch(/contextWindowCustom|maxTokensCustom/);
		const legacyKeys = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens"];
		for (const model of savedModels(wire)) {
			for (const key of Object.keys(model)) expect(legacyKeys).toContain(key);
		}
	});

	it("omits invalid or empty custom values instead of sending NaN", () => {
		const { container, sent } = mount();
		type(spec(container, 0, "ctx").input!, "abc");
		type(spec(container, 0, "max").input!, "");
		const models = savedModels(save(container, sent));
		expect(models[0]).toEqual({ id: "ciallo/claude-opus-5-5" });
	});

	it("reopens a saved custom config in custom mode", () => {
		const first = mount();
		type(spec(first.container, 0, "ctx").input!, "300000");
		const wire = save(first.container, first.sent);
		act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";

		const { container } = mount([wire.config]);
		expect(spec(container, 0, "ctx").select.value).toBe("custom");
		expect(spec(container, 0, "ctx").input?.value).toBe("300000");
		expect(spec(container, 1, "ctx").select.value).toBe("131072");
		expect(spec(container, 1, "ctx").input).toBeNull();
	});
});
