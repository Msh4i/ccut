/**
 * The tools an agent can call (the list lives in apps/electron/mcp-tools.js), run against the
 * editor through a narrow API. The Electron side has already validated the input against each
 * tool's schema; every value is checked again here because this is where it touches the project.
 * A failure throws an Error whose message is short and safe to show an agent: no paths, no stack.
 */
export type McpJson = null | boolean | number | string | McpJson[] | { [key: string]: McpJson };

export type McpElementInfo = {
	id: string;
	trackId: string;
	type: string;
	name: string;
	startSeconds: number;
	durationSeconds: number;
};

export interface McpEditorApi {
	project(): { name: string; width: number; height: number; fps: number; durationSeconds: number } | null;
	tracks(): Array<{ id: string; kind: "main" | "overlay" | "audio"; name: string; type: string; elements: number }>;
	elements(trackId?: string): McpElementInfo[];
	assets(): Array<{ id: string; name: string; kind: string; durationSeconds: number | null }>;
	playhead(): { seconds: number; playing: boolean };
	selection(): string[];
	snapshotBase64(maxWidth: number): Promise<string | null>;
	addAsset(request: { assetId: string; startSeconds?: number; trackId?: string }): { elementId: string | null };
	splitAt(request: { seconds: number; elementId?: string }): number;
	deleteElement(elementId: string): void;
	moveElement(request: { elementId: string; startSeconds: number; trackId?: string }): void;
	setProperty(request: { elementId: string; property: string; value: number | string | boolean }): void;
	addKeyframe(request: { elementId: string; property: string; seconds: number; value: number | string | boolean }): void;
	applyPreset(request: { elementId: string; presetId: string; placement?: string; seconds?: number }): void;
	setText(request: { elementId: string; text: string }): void;
	seek(seconds: number): void;
	play(): void;
	pause(): void;
}

export class McpToolError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function str({ args, key }: { args: Record<string, unknown>; key: string }): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0 || value.length > 5000) {
		throw new McpToolError(`"${key}" must be a text.`);
	}
	return value;
}

function optionalStr({ args, key }: { args: Record<string, unknown>; key: string }): string | undefined {
	return args[key] === undefined ? undefined : str({ args, key });
}

function num({ args, key }: { args: Record<string, unknown>; key: string }): number {
	const value = args[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 24 * 3600) {
		throw new McpToolError(`"${key}" must be a number of seconds, 0 or more.`);
	}
	return value;
}

function optionalNum({ args, key }: { args: Record<string, unknown>; key: string }): number | undefined {
	return args[key] === undefined ? undefined : num({ args, key });
}

function scalar({ args, key }: { args: Record<string, unknown>; key: string }): number | string | boolean {
	const value = args[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length <= 5000) return value;
	if (typeof value === "boolean") return value;
	throw new McpToolError(`"${key}" must be a number, a text or true / false.`);
}

/** Runs one tool. Resolves a JSON value; throws McpToolError (a safe message) for anything wrong. */
export async function runMcpTool({
	tool,
	args,
	api,
}: {
	tool: string;
	args: unknown;
	api: McpEditorApi;
}): Promise<McpJson | { base64: string }> {
	const input = isRecord(args) ? args : {};
	switch (tool) {
		case "get_project":
			return api.project() ?? { open: false };
		case "list_tracks":
			return api.tracks();
		case "list_elements":
			return api.elements(optionalStr({ args: input, key: "trackId" }));
		case "list_assets":
			return api.assets();
		case "get_playhead":
			return api.playhead();
		case "get_selection":
			return api.selection();
		case "get_preview_frame": {
			const maxWidth = typeof input.maxWidth === "number" ? Math.max(64, Math.min(1280, Math.round(input.maxWidth))) : 640;
			const base64 = await api.snapshotBase64(maxWidth);
			if (!base64) throw new McpToolError("No frame could be captured (is the project empty?).");
			return { base64 };
		}
		case "add_asset_to_timeline":
			return api.addAsset({
				assetId: str({ args: input, key: "assetId" }),
				startSeconds: optionalNum({ args: input, key: "startSeconds" }),
				trackId: optionalStr({ args: input, key: "trackId" }),
			});
		case "split_at":
			return { split: api.splitAt({ seconds: num({ args: input, key: "seconds" }), elementId: optionalStr({ args: input, key: "elementId" }) }) };
		case "delete_element":
			api.deleteElement(str({ args: input, key: "elementId" }));
			return { ok: true };
		case "move_element":
			api.moveElement({
				elementId: str({ args: input, key: "elementId" }),
				startSeconds: num({ args: input, key: "startSeconds" }),
				trackId: optionalStr({ args: input, key: "trackId" }),
			});
			return { ok: true };
		case "set_property":
			api.setProperty({ elementId: str({ args: input, key: "elementId" }), property: str({ args: input, key: "property" }), value: scalar({ args: input, key: "value" }) });
			return { ok: true };
		case "add_keyframe":
			api.addKeyframe({
				elementId: str({ args: input, key: "elementId" }),
				property: str({ args: input, key: "property" }),
				seconds: num({ args: input, key: "seconds" }),
				value: scalar({ args: input, key: "value" }),
			});
			return { ok: true };
		case "apply_keyframe_preset":
			api.applyPreset({
				elementId: str({ args: input, key: "elementId" }),
				presetId: str({ args: input, key: "presetId" }),
				placement: optionalStr({ args: input, key: "placement" }),
				seconds: optionalNum({ args: input, key: "seconds" }),
			});
			return { ok: true };
		case "set_text":
			api.setText({ elementId: str({ args: input, key: "elementId" }), text: str({ args: input, key: "text" }) });
			return { ok: true };
		case "seek":
			api.seek(num({ args: input, key: "seconds" }));
			return { ok: true };
		case "play":
			api.play();
			return { ok: true };
		case "pause":
			api.pause();
			return { ok: true };
		default:
			throw new McpToolError("Unknown tool.");
	}
}
