import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { KeyframePresetId, KeyframePresetPlacement } from "@/animation/keyframe-presets";
import { updateElementInSceneTracks } from "@/timeline";
import type { SceneTracks } from "@/timeline";
import { applyKeyframePresetToElement } from "@/timeline/keyframe-preset";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import type { MediaTime } from "@/wasm";

/**
 * Writes a ready-made keyframe animation (zoom, pulse, fade ...) into a clip as
 * ordinary keyframes, in one command, so one undo takes all of it back. Inside
 * the preset's range its paths' own keys are replaced, outside they stay.
 * Throws, writing nothing, when the clip is missing, lacks a property the
 * preset needs (an image has no volume) or is too short for it.
 */
export class ApplyKeyframePresetCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly presetId: KeyframePresetId;
	private readonly placement: KeyframePresetPlacement;
	private readonly seconds: number;
	private readonly playhead: MediaTime;

	constructor({
		trackId,
		elementId,
		presetId,
		placement,
		seconds,
		playhead,
	}: {
		trackId: string;
		elementId: string;
		presetId: KeyframePresetId;
		placement: KeyframePresetPlacement;
		seconds: number;
		/** The playhead on the timeline. */
		playhead: MediaTime;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.presetId = presetId;
		this.placement = placement;
		this.seconds = seconds;
		this.playhead = playhead;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		const track = findTrackInSceneTracks({ tracks, trackId: this.trackId });
		const current = track?.elements.find(
			(candidate) => candidate.id === this.elementId,
		);
		if (!current) {
			throw new Error(
				`Keyframe preset: the element "${this.elementId}" is not on the track "${this.trackId}".`,
			);
		}
		const canvas = editor.project.getActive()?.settings.canvasSize;
		if (!canvas) {
			throw new Error("Keyframe preset: there is no open project.");
		}
		const applied = applyKeyframePresetToElement({
			element: current,
			presetId: this.presetId,
			placement: this.placement,
			seconds: this.seconds,
			playheadLocal: this.playhead - current.startTime,
			canvas,
		});
		if (!applied) {
			throw new Error(
				`Keyframe preset "${this.presetId}" does not fit the element "${this.elementId}".`,
			);
		}

		const updatedTracks = updateElementInSceneTracks({
			tracks,
			trackId: this.trackId,
			elementId: this.elementId,
			update: () => applied.element,
		});

		this.savedState = tracks;
		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}
