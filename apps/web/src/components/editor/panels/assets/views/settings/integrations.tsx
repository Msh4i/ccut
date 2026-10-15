"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Section, SectionContent, SectionHeader, SectionTitle } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { McpColor } from "@/mcp/glow-state";
import type { McpLogEntry, McpSnippets } from "@/mcp/bridge";
import { useMcpState } from "@/mcp/use-mcp-state";

const COLORS: McpColor[] = ["orange", "blue", "violet"];
const DOT: Record<McpColor, string> = { orange: "#ff8a1f", blue: "#2f7bff", violet: "#8b5cf6" };

function CopyBlock({ title, text }: { title: string; text: string }) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between">
				<span className="text-xs">{title}</span>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						void navigator.clipboard.writeText(text).then(
							() => toast.success("Copied"),
							() => toast.error("Could not copy"),
						);
					}}
				>
					Copy
				</Button>
			</div>
			<pre className="bg-muted overflow-x-auto rounded-sm p-2 text-[11px] leading-snug whitespace-pre-wrap break-all">{text}</pre>
		</div>
	);
}

/** Settings > Integrations: lets agents (Claude Code, Codex ...) connect to the app. Off until turned on. */
export function IntegrationsSettings() {
	const { bridge, state } = useMcpState();
	const [snippets, setSnippets] = useState<McpSnippets | null>(null);
	const [log, setLog] = useState<McpLogEntry[] | null>(null);

	if (!bridge || !state) {
		return (
			<Section showTopBorder={false}>
				<SectionContent className="px-3 py-3 text-sm text-muted-foreground">Agents can connect only in the desktop app.</SectionContent>
			</Section>
		);
	}

	const toggle = async (enabled: boolean) => {
		const next = await bridge.setEnabled(enabled);
		if (!next) toast.error("Could not change the integration");
		setSnippets(enabled && next?.running ? await bridge.snippets() : null);
	};

	return (
		<div className="flex flex-col">
			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="flex-1">Agents (MCP)</SectionTitle>
					<Switch checked={state.enabled} onCheckedChange={(checked) => void toggle(checked)} aria-label="Let agents connect" />
				</SectionHeader>
				<SectionContent className="px-3 pb-3 text-xs text-muted-foreground">
					Off by default. When on, Ccut listens on this computer only (127.0.0.1) and an agent needs the token below. The first time an agent connects you choose read only, read and edit, or deny. Every change an agent makes is one undo step.
					{state.running && <span className="text-foreground block pt-1">Listening on port {state.port}.</span>}
				</SectionContent>
			</Section>

			{state.running && (
				<Section>
					<SectionHeader>
						<SectionTitle className="flex-1">Connect an agent</SectionTitle>
						<Button variant="outline" size="sm" onClick={() => void bridge.snippets().then(setSnippets)}>
							{snippets ? "Refresh" : "Show"}
						</Button>
					</SectionHeader>
					<SectionContent className="flex flex-col gap-3 px-3 pb-3">
						{snippets ? (
							<>
								<CopyBlock title="Claude Code" text={snippets.claudeCode} />
								<CopyBlock title="Codex (~/.codex/config.toml)" text={snippets.codex} />
								<span className="text-xs text-muted-foreground">These two start a small helper that reads the token from a private file, so the token is not written into any config or command history.</span>
								<details className="text-xs">
									<summary className="cursor-pointer text-muted-foreground">Advanced: HTTP with the token in the command</summary>
									<div className="flex flex-col gap-3 pt-2">
										<span className="text-destructive">These contain the token. A command line is visible to other programs on this computer (ps), is kept in your shell history, and Claude Code stores it in plain text in ~/.claude.json. Prefer the two above.</span>
										<CopyBlock title="Claude Code (HTTP)" text={snippets.claudeCodeHttp} />
										<CopyBlock title="Other clients (JSON)" text={snippets.json} />
									</div>
								</details>
								<div className="flex items-center gap-2">
									<Button
										variant="destructive-foreground"
										size="sm"
										onClick={() =>
											void bridge.regenerateToken().then(async (next) => {
												setSnippets(next?.running ? await bridge.snippets() : null);
												toast.success("New token made; connected agents were disconnected");
											})
										}
									>
										Make a new token
									</Button>
									<span className="text-xs text-muted-foreground">The token is a password for this computer: do not share it.</span>
								</div>
							</>
						) : (
							<span className="text-xs text-muted-foreground">The snippets contain the token, so they are shown only when you ask.</span>
						)}
					</SectionContent>
				</Section>
			)}

			{state.running && (
				<Section>
					<SectionHeader>
						<SectionTitle className="flex-1">Connected</SectionTitle>
					</SectionHeader>
					<SectionContent className="flex flex-col gap-2 px-3 pb-3">
						{state.clients.length === 0 && <span className="text-xs text-muted-foreground">Nobody is connected.</span>}
						{state.clients.map((client) => (
							<div key={client.id} className="flex flex-col gap-1 rounded-sm border p-2">
								<div className="flex items-center justify-between gap-2">
									<span className="truncate text-sm">{client.name}</span>
									<Button variant="outline" size="sm" onClick={() => void bridge.disconnect(client.id)}>
										Disconnect
									</Button>
								</div>
								<div className="text-muted-foreground flex items-center justify-between text-xs">
									<span>{client.level === "edit" ? "Read and edit" : "Read only"} · {client.calls} calls</span>
									<span className="flex items-center gap-1" role="radiogroup" aria-label={`Glow color of ${client.name}`}>
										{COLORS.map((color) => (
											<button
												key={color}
												type="button"
												role="radio"
												aria-checked={client.color === color}
												aria-label={color}
												onClick={() => void bridge.setColor({ name: client.name, color })}
												className="size-4 rounded-full border"
												style={{ background: DOT[color], outline: client.color === color ? "2px solid currentColor" : "none", outlineOffset: 1 }}
											/>
										))}
									</span>
								</div>
							</div>
						))}
						<span className="text-xs text-muted-foreground">
							The name shown here is what the program calls itself; it is not proof of who it is. It only picks the glow color. A read and edit choice is asked again at every new connection.
						</span>
						{Object.keys(state.grants).length > 0 && (
							<div className="flex flex-col gap-1 pt-1">
								<Label className="text-xs">Remembered choices</Label>
								{Object.entries(state.grants).map(([name, level]) => (
									<div key={name} className="flex items-center justify-between text-xs">
										<span className="truncate">{name}: {level === "edit" ? "read and edit" : "read only"}</span>
										<Button variant="text" size="sm" onClick={() => void bridge.forget(name)}>
											Forget
										</Button>
									</div>
								))}
							</div>
						)}
					</SectionContent>
				</Section>
			)}

			{state.running && (
				<Section>
					<SectionHeader>
						<SectionTitle className="flex-1">Last calls</SectionTitle>
						<Button variant="outline" size="sm" onClick={() => void bridge.log().then(setLog)}>
							{log ? "Refresh" : "Show"}
						</Button>
					</SectionHeader>
					<SectionContent className="px-3 pb-3">
						{log === null ? null : log.length === 0 ? (
							<span className="text-xs text-muted-foreground">No calls yet.</span>
						) : (
							<ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto text-[11px]">
								{[...log].reverse().map((entry, index) => (
									<li key={`${entry.at}-${index}`} className={entry.ok ? "" : "text-destructive"}>
										{new Date(entry.at).toLocaleTimeString()} {entry.client}: {entry.tool} ({entry.ms} ms){entry.error ? ` - ${entry.error}` : ""}
									</li>
								))}
							</ul>
						)}
					</SectionContent>
				</Section>
			)}
		</div>
	);
}
