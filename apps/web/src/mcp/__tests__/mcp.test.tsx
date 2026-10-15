import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getMcpBridge, parseMcpState } from "@/mcp/bridge";
import { LINGER_MS, activeGlows, applyActivity, edgesFor, type GlowState } from "@/mcp/glow-state";
import { McpGlowView } from "@/mcp/mcp-glow";
import { McpToolError, runMcpTool, type McpEditorApi } from "@/mcp/tools";

function fakeApi() {
	const calls: Array<[string, unknown]> = [];
	const record = (name: string) => (...args: unknown[]) => void calls.push([name, args.length === 1 ? args[0] : args]);
	const api: McpEditorApi = {
		project: () => ({ name: "P", width: 1920, height: 1080, fps: 30, durationSeconds: 12 }),
		tracks: () => [],
		elements: (trackId) => (calls.push(["elements", trackId]), []),
		assets: () => [],
		playhead: () => ({ seconds: 1.5, playing: false }),
		selection: () => ["a"],
		snapshotBase64: async (maxWidth) => (maxWidth === 640 ? "AAAA" : maxWidth === 64 ? "BBBB" : null),
		addAsset: (request) => (calls.push(["addAsset", request]), { elementId: null }),
		splitAt: (request) => (calls.push(["splitAt", request]), 2),
		deleteElement: record("deleteElement"),
		moveElement: record("moveElement"),
		setProperty: record("setProperty"),
		addKeyframe: record("addKeyframe"),
		applyPreset: record("applyPreset"),
		setText: record("setText"),
		seek: record("seek"),
		play: record("play"),
		pause: record("pause"),
	};
	return { api, calls };
}

describe("agent tools in the page", () => {
	test("read tools answer from the editor", async () => {
		const { api } = fakeApi();
		expect(await runMcpTool({ tool: "get_project", args: {}, api })).toMatchObject({ name: "P", fps: 30 });
		expect(await runMcpTool({ tool: "get_playhead", args: {}, api })).toEqual({ seconds: 1.5, playing: false });
		expect(await runMcpTool({ tool: "get_selection", args: {}, api })).toEqual(["a"]);
	});

	test("the preview frame is capped at 1280 px and floored at 64, 640 by default; no frame is an error", async () => {
		const { api } = fakeApi();
		expect(await runMcpTool({ tool: "get_preview_frame", args: {}, api })).toEqual({ base64: "AAAA" });
		expect(await runMcpTool({ tool: "get_preview_frame", args: { maxWidth: 1 }, api })).toEqual({ base64: "BBBB" });
		await expect(runMcpTool({ tool: "get_preview_frame", args: { maxWidth: 1280 }, api })).rejects.toThrow(McpToolError);
	});

	test("edit tools pass checked values to the editor", async () => {
		const { api, calls } = fakeApi();
		expect(await runMcpTool({ tool: "split_at", args: { seconds: 4.5 }, api })).toEqual({ split: 2 });
		await runMcpTool({ tool: "set_property", args: { elementId: "a", property: "opacity", value: 0.5 }, api });
		await runMcpTool({ tool: "seek", args: { seconds: 2 }, api });
		expect(calls).toEqual([
			["splitAt", { seconds: 4.5, elementId: undefined }],
			["setProperty", { elementId: "a", property: "opacity", value: 0.5 }],
			["seek", 2],
		]);
	});

	test("wrong input is refused before the editor is touched", async () => {
		const { api, calls } = fakeApi();
		for (const [tool, args] of [
			["split_at", { seconds: -1 }],
			["split_at", { seconds: "x" }],
			["delete_element", {}],
			["delete_element", { elementId: "" }],
			["set_property", { elementId: "a", property: "p", value: { evil: true } }],
			["set_property", { elementId: "a", property: "p", value: Number.NaN }],
			["seek", { seconds: 1e9 }],
			["nope", {}],
		] as const) {
			await expect(runMcpTool({ tool, args, api })).rejects.toThrow(McpToolError);
		}
		expect(calls).toEqual([]);
	});
});

describe("the glow", () => {
	const event = ({ clientId, running, color = "orange" }: { clientId: string; running: boolean; color?: string }) => ({ clientId, color, running });

	test("an agent glows while a call runs and 2 s after, then stops", () => {
		let state: GlowState = {};
		state = applyActivity({ state, event: event({ clientId: "a", running: true }), now: 1000 });
		expect(activeGlows({ state, now: 9000 }).glows).toEqual([{ clientId: "a", color: "orange" }]);
		state = applyActivity({ state, event: event({ clientId: "a", running: false }), now: 10_000 });
		expect(activeGlows({ state, now: 10_000 + LINGER_MS - 1 }).glows).toHaveLength(1);
		const after = activeGlows({ state, now: 10_000 + LINGER_MS + 1 });
		expect(after.glows).toEqual([]);
		expect(after.state).toEqual({});
	});

	test("two overlapping calls of one agent keep it glowing until both end", () => {
		let state: GlowState = {};
		state = applyActivity({ state, event: event({ clientId: "a", running: true }), now: 0 });
		state = applyActivity({ state, event: event({ clientId: "a", running: true }), now: 1 });
		state = applyActivity({ state, event: event({ clientId: "a", running: false }), now: 2 });
		expect(activeGlows({ state, now: 100_000 }).glows).toHaveLength(1);
		state = applyActivity({ state, event: event({ clientId: "a", running: false }), now: 3 });
		expect(activeGlows({ state, now: 3 + LINGER_MS + 1 }).glows).toHaveLength(0);
	});

	test("two agents at once get two colours on different edges; one agent gets all four", () => {
		expect(edgesFor({ index: 0, count: 1 })).toEqual(["top", "right", "bottom", "left"]);
		expect(edgesFor({ index: 0, count: 2 })).toEqual(["top", "bottom"]);
		expect(edgesFor({ index: 1, count: 2 })).toEqual(["left", "right"]);
		const html = renderToStaticMarkup(<McpGlowView glows={[{ clientId: "a", color: "orange" }, { clientId: "b", color: "blue" }]} />);
		expect(html.match(/data-color="orange"/g)).toHaveLength(2);
		expect(html.match(/data-color="blue"/g)).toHaveLength(2);
		expect(html).toContain("pointer-events-none");
		expect(html).toContain("prefers-reduced-motion");
	});

	test("nothing is drawn while nobody works", () => {
		expect(renderToStaticMarkup(<McpGlowView glows={[]} />)).toBe("");
	});

	test("an unknown colour falls back to violet", () => {
		const state = applyActivity({ state: {}, event: { clientId: "x", color: "pink", running: true }, now: 0 });
		expect(state.x.color).toBe("violet");
	});
});

describe("the page's view of the bridge", () => {
	test("there is no bridge in a browser", () => {
		expect(getMcpBridge({ scope: {} })).toBeNull();
	});

	test("the state from the main process is read defensively", () => {
		expect(parseMcpState(null)).toBeNull();
		expect(parseMcpState({ enabled: true, running: true, port: 5, clients: [{ id: "1", name: "claude-code", level: "read", color: "orange", calls: 2 }, { nope: 1 }], grants: { a: "root", b: "edit" }, colors: { c: "pink", d: "blue" } })).toEqual({
			enabled: true,
			running: true,
			port: 5,
			clients: [{ id: "1", name: "claude-code", version: "", level: "read", color: "orange", connectedAt: 0, calls: 2 }],
			grants: { b: "edit" },
			colors: { d: "blue" },
		});
	});
});
