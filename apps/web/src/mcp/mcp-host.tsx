"use client";

import { useEffect } from "react";
import { useEditor } from "@/editor/use-editor";
import { getMcpBridge } from "./bridge";
import { createMcpEditorApi } from "./editor-api";
import { McpGlow } from "./mcp-glow";
import { McpToolError, runMcpTool } from "./tools";

/**
 * Mounted once in the editor. In the desktop app it answers the agents' tool requests with the
 * editor (every tool is one undo step) and draws the glow; in a browser it does nothing.
 */
export function McpHost() {
	const editor = useEditor();

	useEffect(() => {
		const bridge = getMcpBridge();
		if (!bridge) return;
		return bridge.onRequest(async ({ tool, args }) => {
			if (typeof tool !== "string") throw new McpToolError("Unknown tool.");
			try {
				return await runMcpTool({ tool, args, api: createMcpEditorApi({ editor }) });
			} catch (error) {
				// Only a short message of ours reaches the agent.
				throw error instanceof McpToolError ? error : new Error("The editor could not do that.");
			}
		});
	}, [editor]);

	return <McpGlow />;
}
