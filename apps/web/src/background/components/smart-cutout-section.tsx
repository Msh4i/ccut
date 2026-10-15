"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AiMagicIcon,
	Cancel01Icon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Switch } from "@/components/ui/switch";
import { SMART_CUTOUT_ENABLED_KEY } from "@/background/matte/matte-registry";
import { SMART_CUTOUT_MODEL } from "@/background/smart-cutout/constants";
import {
	getModelsBridge,
	type ModelStatus,
} from "@/background/smart-cutout/models-bridge";
import {
	cancelCutout,
	clearCutout,
	getCutoutState,
	startCutout,
	subscribeCutout,
} from "@/background/smart-cutout/service";
import { useEditor } from "@/editor/use-editor";
import type { VideoElement } from "@/timeline";

const MODEL_MB = (SMART_CUTOUT_MODEL.sizeBytes / 1_000_000).toFixed(1);

/**
 * "Smart cutout": the subject is cut out of the background by a small model that runs on this
 * computer. It needs a one-time model download (asked in a native dialog, Cancel is the default).
 */
export function SmartCutoutSection({
	element,
	trackId,
}: {
	element: VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const bridge = getModelsBridge();
	const [model, setModel] = useState<ModelStatus | null>(null);
	const state = useSyncExternalStore(
		subscribeCutout,
		() => getCutoutState({ elementId: element.id }),
		() => getCutoutState({ elementId: element.id }),
	);
	const asset = editor.media.getAssets().find((candidate) => candidate.id === element.mediaId);
	const enabled = element.params[SMART_CUTOUT_ENABLED_KEY] === true;
	const running = state.phase === "running" || state.phase === "loading-model";
	const hasResult = state.phase === "done" || enabled;

	useEffect(() => {
		if (!bridge) return;
		let alive = true;
		const refresh = async () => {
			const status = await bridge.status();
			if (alive) setModel(status);
		};
		void refresh();
		// follows a running download
		const timer = window.setInterval(() => void refresh(), 700);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, [bridge]);

	const setEnabled = (value: boolean) =>
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: { params: { ...element.params, [SMART_CUTOUT_ENABLED_KEY]: value } },
				},
			],
		});

	const download = async () => {
		if (!bridge) return;
		const result = await bridge.install();
		if (result.ok) toast.success("Smart cutout model installed.");
		else if (result.code !== "consent-declined" && result.code !== "cancelled") {
			toast.error("The model could not be downloaded or did not match its checksum.");
		}
		setModel(await bridge.status());
	};

	const run = async () => {
		if (!asset) return;
		const ready = await startCutout({ element, asset });
		if (ready) setEnabled(true);
	};

	const message =
		state.phase === "model-missing" ||
		state.phase === "error" ||
		state.phase === "cancelled" ||
		state.phase === "unsupported"
			? state.message
			: null;

	return (
		<Section sectionKey={`${element.id}:smart-cutout`}>
			<SectionHeader
				trailing={
					bridge ? (
						<Switch
							aria-label="Use the cutout"
							title="Use the cutout"
							checked={enabled}
							onCheckedChange={setEnabled}
						/>
					) : undefined
				}
			>
				<SectionTitle className="text-foreground">Smart cutout</SectionTitle>
			</SectionHeader>
			<SectionContent>
				{!bridge ? (
					<p className="text-muted-foreground text-xs leading-relaxed">
						Finds the person or object and removes the rest. Available in the desktop
						app.
					</p>
				) : (
					<SectionFields>
						{model && !model.installed ? (
							<div className="bg-foreground/5 flex flex-col gap-2.5 rounded-md p-3">
								<div className="flex items-start gap-2.5">
									<HugeiconsIcon icon={AiMagicIcon} className="text-primary mt-0.5 size-4 shrink-0" />
									<p className="text-muted-foreground text-xs leading-relaxed">
										Finds the person or object and removes the rest. Needs a one-time
										download ({MODEL_MB} MB); it runs on this computer and nothing is
										uploaded.
									</p>
								</div>
								{model.installing ? (
									<div className="flex items-center gap-2">
										<Progress value={model.percent ?? 0} className="h-1.5 flex-1" />
										<Button
											variant="ghost"
											size="icon"
											aria-label="Cancel download"
											title="Cancel download"
											onClick={() => void bridge.cancelInstall()}
										>
											<HugeiconsIcon icon={Cancel01Icon} />
										</Button>
									</div>
								) : (
									<Button variant="secondary" size="sm" onClick={() => void download()}>
										<HugeiconsIcon icon={Download04Icon} />
										Download model
									</Button>
								)}
							</div>
						) : null}

						{running ? (
							<div className="flex flex-col gap-2">
								<div className="flex items-center gap-2">
									<Progress
										value={state.total > 0 ? (state.done / state.total) * 100 : 0}
										className="h-1.5 flex-1"
									/>
									<Button
										variant="ghost"
										size="icon"
										aria-label="Cancel"
										title="Cancel"
										onClick={() => cancelCutout({ elementId: element.id })}
									>
										<HugeiconsIcon icon={Cancel01Icon} />
									</Button>
								</div>
								<p className="text-muted-foreground text-xs">
									{state.phase === "loading-model"
										? "Loading the model..."
										: `Frame ${state.done} of ${state.total}`}
								</p>
							</div>
						) : (
							<Button
								variant="secondary"
								size="sm"
								className="w-full"
								disabled={!asset || !model?.installed}
								title={model?.installed ? undefined : "Download the model first"}
								onClick={() => void run()}
							>
								<HugeiconsIcon icon={AiMagicIcon} />
								{hasResult ? "Cut out again" : "Cut out the subject"}
							</Button>
						)}

						{message ? (
							<p
								className={
									state.phase === "model-missing" || state.phase === "error"
										? "text-destructive text-xs"
										: "text-muted-foreground text-xs"
								}
							>
								{message}
							</p>
						) : null}
						{state.stride > 1 && state.phase !== "idle" ? (
							<p className="text-muted-foreground text-xs leading-relaxed">
								Long clip: every {state.stride}. frame is analysed, the frames in between
								are filled in.
							</p>
						) : null}

						{hasResult || asset ? (
							<div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
								<span>Trimming later needs a new run.</span>
								{asset ? (
									<button
										type="button"
										className="hover:text-foreground cursor-pointer underline-offset-2 hover:underline"
										onClick={() =>
											void clearCutout({ element, asset }).then(() => setEnabled(false))
										}
									>
										Delete cutout
									</button>
								) : null}
							</div>
						) : null}
					</SectionFields>
				)}
			</SectionContent>
		</Section>
	);
}
