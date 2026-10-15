"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import {
	BEAT_MAX_DURATION_SECONDS,
	decodeStemFileForBeats,
	probeAudioFileSeconds,
	STEM_DURATION_TOLERANCE_SECONDS,
	stemMatchesSource,
	type StemAudioResult,
} from "@/media/beat-audio";
import { decodeElementForSeparation } from "@/media/stem-audio";
import { beatDetectionService } from "@/services/beat-detection/service";
import { getStemsBridge } from "@/services/stems/bridge";
import { createStemCache, type StemCache } from "@/services/stems/cache";
import { separateStems } from "@/services/stems/separate";
import { OPFSAdapter } from "@/services/storage/opfs-adapter";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";
import { createAnalysisCache } from "./analysis-cache";
import { pickAudioFile } from "./pick-audio-file";
import { clearBeatSelection } from "./selection";
import {
	runBeatJob,
	type BeatJobStatus,
	type SourceAnalysis,
} from "./job";
import { stemChoiceLabel, type StemChoice } from "./stem-choice";
import { useStemChoiceStore } from "./stem-choice-store";
import { getStemAudio, type StemDeps } from "./stem-samples";
import {
	getBeatSelection,
	isOneSource,
	type BeatButtonState,
	type BeatTarget,
} from "./targets";

const useBeatJobStore = create<{ running: boolean }>(() => ({
	running: false,
}));

const analysisCache = createAnalysisCache<SourceAnalysis>();

let stemCache: StemCache | null | undefined;
/** The on-disk stem cache of this browser profile; null where OPFS does not exist. */
function getStemCache(): StemCache | null {
	if (stemCache === undefined) {
		stemCache = OPFSAdapter.isSupported()
			? createStemCache({ adapter: new OPFSAdapter("stem-cache") })
			: null;
	}
	return stemCache;
}

/** The stem cache for the settings menu (size, clear); null where there is none. */
export function getSeparatedStemsCache(): StemCache | null {
	return getStemCache();
}

function getTooltip({
	state,
	choice,
}: {
	state: BeatButtonState;
	choice: StemChoice;
}): string {
	const label = stemChoiceLabel({ choice });
	switch (state) {
		case "ready":
			return `${label} (right-click to change)`;
		case "active":
			return "Remove beat markers";
		case "no-clip":
			return `${label} (select an audio or video clip)`;
		case "separated-audio":
			return "Select the extracted audio clip to detect beats";
		case "no-audio":
			return "This clip has no audio";
	}
}

/**
 * The one "Auto hits" button: the stem and the marker mode come from the sticky choice
 * (`useStemChoiceStore`), left click runs it, a second click removes the markers.
 */
export function useAutoHits() {
	const editor = useEditor();
	const state = useEditor((current) => getSelectedBeats(current).state);
	const running = useBeatJobStore((store) => store.running);
	const stem = useStemChoiceStore((store) => store.stem);
	const mode = useStemChoiceStore((store) => store.mode);
	const choice: StemChoice = { stem, mode };

	const run = useCallback(
		async ({ ownStem }: { ownStem?: File } = {}) => {
			if (useBeatJobStore.getState().running) {
				return;
			}
			const { targets, state: current } = getSelectedBeats(editor);
			if (current === "active") {
				// A click on a button that shows markers removes them (a stem file is only for a fresh run).
				if (ownStem) return;
				clearBeatSelection();
				editor.timeline.updateElements({
					updates: targets.map((target) => ({
						trackId: target.trackId,
						elementId: target.element.id,
						patch: { beats: undefined },
					})),
				});
				return;
			}
			if (current !== "ready") {
				return;
			}

			const pending = targets.filter((target) => !target.element.beats);
			// A stem file is one media's audio: it must not be laid over other media.
			if (ownStem && !isOneSource({ targets: pending })) {
				toast.error("Select the clips of one media to use a stem file");
				return;
			}

			useBeatJobStore.setState({ running: true });
			try {
				const { stem: chosenStem, mode: chosenMode } = useStemChoiceStore.getState();
				await detectBeatsForTargets({
					editor,
					choice: { stem: chosenStem, mode: chosenMode },
					ownStem,
					targets: pending,
				});
			} finally {
				useBeatJobStore.setState({ running: false });
			}
		},
		[editor],
	);

	const toggle = useCallback(() => run(), [run]);

	// The user's own stem file (made elsewhere) instead of separating the clip's audio here.
	const toggleWithOwnStem = useCallback(async () => {
		if (useBeatJobStore.getState().running) {
			return;
		}
		if (getSelectedBeats(editor).state !== "ready") {
			return;
		}
		const ownStem = await pickAudioFile();
		if (ownStem) {
			await run({ ownStem });
		}
	}, [editor, run]);

	return {
		isAvailable: state === "ready" || state === "active",
		isActive: state === "active",
		isRunning: running,
		label: stemChoiceLabel({ choice }),
		tooltip: running ? "Working..." : getTooltip({ state, choice }),
		canPickOwnStem: state === "ready" && !running,
		toggle,
		toggleWithOwnStem,
	};
}

function getSelectedBeats(editor: EditorCore): ReturnType<typeof getBeatSelection> {
	const selected = editor.selection.getSelectedElements();
	// Runs on every editor change: skip the lookups when there is nothing to do.
	if (selected.length === 0) {
		return { targets: [], state: "no-clip" };
	}
	return getBeatSelection({
		selected: editor.timeline.getElementsWithTracks({ elements: selected }),
		mediaAssets: editor.media.getAssets(),
	});
}

function describeStatus({
	status,
	choice,
}: {
	status: BeatJobStatus;
	choice: StemChoice;
}): string {
	const position = status.sources > 1 ? ` ${status.source}/${status.sources}` : "";
	switch (status.phase) {
		case "installing":
			return `Installing the stem separator${position}... ${status.percent}%`;
		case "repairing":
			return `The stem separator has to be installed again (the app was updated or a file changed)${position}...`;
		case "reading":
			return `Reading audio${position}...`;
		case "separating":
			return status.percent < 5
				? `Starting the stem separator${position}... (about 15 s)`
				: `Separating stems${position}... ${status.percent}%`;
		case "detecting":
			return `Detecting ${choice.mode === "hits" ? "hits" : "beats"}${position}... ${status.percent}%`;
	}
}

async function detectBeatsForTargets({
	editor,
	choice,
	ownStem,
	targets,
}: {
	editor: EditorCore;
	choice: StemChoice;
	ownStem?: File;
	targets: BeatTarget[];
}): Promise<void> {
	const controller = new AbortController();
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	const toastId = toast.loading("Reading audio...", {
		action: {
			label: "Cancel",
			onClick: (event) => {
				// Keep the toast: the job dismisses it once it has stopped.
				event.preventDefault();
				controller.abort();
				toast.loading("Cancelling...", { id: toastId, action: undefined });
			},
		},
	});
	const deps: StemDeps = {
		bridge: getStemsBridge(),
		cache: getStemCache(),
		decode: decodeElementForSeparation,
		separate: separateStems,
	};

	try {
		const result = await runBeatJob({
			targets,
			signal: controller.signal,
			analyse: ({ target, sourceRange, signal, onProgress, onStage }) =>
				analysisCache.run({
					// The same file analysed another way has another result.
					// ...and only the clips' part of it is separated, so the range is part of it too.
					key: `${target.sourceKey}:${choice.mode}:${ownStem ? `own:${ownStem.name}:${ownStem.size}:${ownStem.lastModified}` : `${choice.stem}:${Math.floor(sourceRange.startSeconds)}-${Math.ceil(sourceRange.endSeconds)}`}`,
					signal,
					start: () =>
						analyse({ target, sourceRange, choice, ownStem, deps, signal, onProgress, onStage }),
				}),
			onStatus: (status) =>
				toast.loading(describeStatus({ status, choice }), { id: toastId }),
			isCurrent: () => editor.project.getActiveOrNull()?.metadata.id === projectId,
			exists: ({ trackId, elementId }) =>
				editor.timeline.getElementsWithTracks({
					elements: [{ trackId, elementId }],
				}).length > 0,
			commit: (updates) =>
				editor.timeline.updateElements({
					updates: updates.map(({ trackId, elementId, beats }) => ({
						trackId,
						elementId,
						patch: { beats },
					})),
				}),
		});
		if (result.kind === "done") {
			toast[result.summary.type](result.summary.message, {
				id: toastId,
				action: undefined,
			});
		} else {
			// A decode cannot be interrupted: stay busy (toast reads "Cancelling...") until
			// it ends, so a new run never starts a second decode of the same file.
			await analysisCache.idle();
			toast.dismiss(toastId);
		}
	} catch (error) {
		// Without this a loading toast would stay on screen for good.
		console.error("Beat detection failed:", error);
		toast.error("Beat detection failed", { id: toastId, action: undefined });
	}
}

async function analyse({
	target,
	sourceRange,
	choice,
	ownStem,
	deps,
	signal,
	onProgress,
	onStage,
}: {
	target: BeatTarget;
	sourceRange: { startSeconds: number; endSeconds: number };
	choice: StemChoice;
	ownStem?: File;
	deps: StemDeps;
	signal: AbortSignal;
	onProgress: (fraction: number) => void;
	onStage: Parameters<typeof getStemAudio>[0]["onStage"];
}): Promise<SourceAnalysis> {
	const audio = ownStem
		? await decodeOwnStem({ target, file: ownStem, signal })
		: await getStemAudio({ target, stem: choice.stem, range: sourceRange, signal, onStage, deps });
	if (!audio.ok) {
		return audio;
	}

	const request = {
		samples: audio.samples,
		sampleRate: audio.sampleRate,
		onProgress,
		signal,
	};
	// A stem of only the clips' part of the source starts at that part's start.
	const offset = audio.offsetSeconds ?? 0;
	const toTicks = (seconds: number[]) =>
		seconds.map((value) => roundMediaTime({ time: (value + offset) * TICKS_PER_SECOND }));

	if (choice.mode === "hits") {
		const hits = await beatDetectionService.detectHits({ ...request, stem: choice.stem });
		return hits.ok ? { ok: true, beats: toTicks(hits.beatsSec) } : hits;
	}
	const result = await beatDetectionService.detect(request);
	return result.ok
		? { ok: true, beats: toTicks(result.beatsSec), bpm: result.bpm }
		: result;
}

/**
 * Beats are stored in source time, so a stem only fits the clip's own media when it covers the
 * same span: a stem of a different song or of an excerpt is refused. The length is read from
 * the file's container first, so a huge or wrong file is refused before anything is decoded.
 */
async function decodeOwnStem({
	target,
	file,
	signal,
}: {
	target: BeatTarget;
	file: File;
	signal: AbortSignal;
}): Promise<StemAudioResult> {
	const sourceSeconds = target.mediaAsset?.duration;
	if (sourceSeconds === undefined) {
		return { ok: false, reason: "stem-mismatch" };
	}
	// The stem is decoded whole: refuse an absurd length before reading the file.
	if (sourceSeconds > BEAT_MAX_DURATION_SECONDS + STEM_DURATION_TOLERANCE_SECONDS) {
		return { ok: false, reason: "too-long" };
	}
	const stemSeconds = await probeAudioFileSeconds({ file });
	if (stemSeconds === null) {
		return { ok: false, reason: "unreadable" };
	}
	if (stemSeconds > BEAT_MAX_DURATION_SECONDS) {
		return { ok: false, reason: "too-long" };
	}
	if (!stemMatchesSource({ stemSeconds, sourceSeconds })) {
		return { ok: false, reason: "stem-mismatch" };
	}
	signal.throwIfAborted();
	return decodeStemFileForBeats({ file, signal });
}
