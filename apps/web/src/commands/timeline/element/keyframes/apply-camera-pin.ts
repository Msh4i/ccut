import { EditorCore } from "@/core";
import { getElementLocalTime } from "@/animation";
import { Command, type CommandResult } from "@/commands/base-command";
import { updateElementInSceneTracks } from "@/timeline";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	applyCameraPinChannels,
	removeCameraPinChannels,
	type CameraPinKeys,
	type CameraPinRange,
} from "@/tracking/camera/pin-animations";
import type { MediaTime } from "@/wasm";

/**
 * The element a camera pin is about, or an error saying why there is none.
 * Checked before anything is written, so a refused pin changes nothing and
 * leaves no undo step.
 */
function requirePinnable({
	tracks,
	trackId,
	elementId,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
}): TimelineElement {
	const track = findTrackInSceneTracks({ tracks, trackId });
	if (!track) {
		throw new Error(`Camera pin: the track "${trackId}" is not in the scene.`);
	}
	const element = track.elements.find((candidate) => candidate.id === elementId);
	if (!element) {
		throw new Error(
			`Camera pin: the element "${elementId}" is not on the track "${trackId}".`,
		);
	}
	if (!resolveAnimationTarget({ element, path: "transform.positionX" })) {
		throw new Error(
			`Camera pin: the element "${elementId}" cannot be moved (it has no transform).`,
		);
	}
	return element;
}

/**
 * Writes the five transform channels of a stuck element (position x and y,
 * scale x and y, rotation) in one command, so it is one undo step. Only the
 * keys inside `range` are replaced; keys outside it, a second pin on another
 * segment among them, stay as they were and the channels hold their end values
 * beyond. Values keep their decimals (`setChannel`, not the whole-pixel
 * keyframe path). Opacity and every other param and animation are untouched.
 * Throws, writing nothing, when the track or element is missing or cannot be
 * moved, or the keys do not fit the range.
 */
export class ApplyCameraPinCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly channels: CameraPinKeys;
	private readonly range: CameraPinRange;

	constructor({
		trackId,
		elementId,
		channels,
		range,
	}: {
		trackId: string;
		elementId: string;
		channels: CameraPinKeys;
		range: CameraPinRange;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.channels = channels;
		this.range = range;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		requirePinnable({ tracks, trackId: this.trackId, elementId: this.elementId });

		const updatedTracks = updateElementInSceneTracks({
			tracks,
			trackId: this.trackId,
			elementId: this.elementId,
			update: (element) => ({
				...element,
				animations: applyCameraPinChannels({
					animations: element.animations,
					channels: this.channels,
					range: this.range,
				}),
			}),
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

/**
 * Unstick: takes the pin's keys out of the five channels and keeps the element
 * where it is at `playhead` (a timeline time), by writing that look into the
 * base params, so nothing jumps. One undo step; undo brings the pin back.
 * Throws, writing nothing, when the track or element is missing.
 */
export class RemoveCameraPinCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly range: CameraPinRange;
	private readonly playhead: MediaTime;

	constructor({
		trackId,
		elementId,
		range,
		playhead,
	}: {
		trackId: string;
		elementId: string;
		range: CameraPinRange;
		playhead: MediaTime;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.range = range;
		this.playhead = playhead;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		requirePinnable({ tracks, trackId: this.trackId, elementId: this.elementId });

		const updatedTracks = updateElementInSceneTracks({
			tracks,
			trackId: this.trackId,
			elementId: this.elementId,
			update: (element) =>
				removeCameraPinChannels({
					element,
					range: this.range,
					localTime: getElementLocalTime({
						timelineTime: this.playhead,
						elementStartTime: element.startTime,
						elementDuration: element.duration,
					}),
				}),
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
