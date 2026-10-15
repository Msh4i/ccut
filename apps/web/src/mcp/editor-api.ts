import { coerceParamValue } from "@/params";
import { getElementParam, writeElementParamValue } from "@/params/registry";
import type { EditorCore } from "@/core";
import { getElementsAtTime } from "@/timeline";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	KEYFRAME_PRESET_DEFINITIONS,
	type KeyframePresetId,
	type KeyframePresetPlacement,
} from "@/animation/keyframe-presets";
import { roundMediaTime, TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import { McpToolError, type McpEditorApi, type McpElementInfo } from "./tools";

const toTime = (seconds: number): MediaTime => roundMediaTime({ time: seconds * TICKS_PER_SECOND });
const toSeconds = (time: number): number => time / TICKS_PER_SECOND;

function tracksOf({ editor }: { editor: EditorCore }): SceneTracks {
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) throw new McpToolError("No project is open.");
	return scene.tracks;
}

function allTracks({ tracks }: { tracks: SceneTracks }): Array<{ track: TimelineTrack; kind: "main" | "overlay" | "audio" }> {
	return [
		...tracks.overlay.map((track) => ({ track, kind: "overlay" as const })),
		{ track: tracks.main, kind: "main" as const },
		...tracks.audio.map((track) => ({ track, kind: "audio" as const })),
	];
}

function find({ editor, elementId }: { editor: EditorCore; elementId: string }): { trackId: string; element: TimelineElement } {
	for (const { track } of allTracks({ tracks: tracksOf({ editor }) })) {
		const element = track.elements.find((candidate) => candidate.id === elementId);
		if (element) return { trackId: track.id, element };
	}
	throw new McpToolError("There is no clip with that id.");
}

const isPresetId = (value: string): value is KeyframePresetId => KEYFRAME_PRESET_DEFINITIONS.some((definition) => definition.id === value);
const isPlacement = (value: string): value is KeyframePresetPlacement => value === "start" || value === "playhead" || value === "end";

/** The real editor behind the tools. Every edit is one command, so one undo step. */
export function createMcpEditorApi({ editor }: { editor: EditorCore }): McpEditorApi {
	return {
		project() {
			const project = editor.project.getActive();
			if (!project) return null;
			const { canvasSize, fps } = project.settings;
			return {
				name: project.metadata.name,
				width: canvasSize.width,
				height: canvasSize.height,
				fps: fps.numerator / fps.denominator,
				durationSeconds: toSeconds(editor.timeline.getTotalDuration()),
			};
		},
		tracks() {
			return allTracks({ tracks: tracksOf({ editor }) }).map(({ track, kind }) => ({
				id: track.id,
				kind,
				name: track.name,
				type: track.type,
				elements: track.elements.length,
			}));
		},
		elements(trackId) {
			const out: McpElementInfo[] = [];
			for (const { track } of allTracks({ tracks: tracksOf({ editor }) })) {
				if (trackId !== undefined && track.id !== trackId) continue;
				for (const element of track.elements) {
					out.push({
						id: element.id,
						trackId: track.id,
						type: element.type,
						name: element.name,
						startSeconds: toSeconds(element.startTime),
						durationSeconds: toSeconds(element.duration),
					});
				}
			}
			return out;
		},
		assets() {
			return editor.media.getAssets().map((asset) => ({ id: asset.id, name: asset.name, kind: asset.type, durationSeconds: asset.duration ?? null }));
		},
		playhead() {
			return { seconds: toSeconds(editor.playback.getCurrentTime()), playing: editor.playback.getIsPlaying() };
		},
		selection() {
			return editor.selection.getSelectedElements().map((ref) => ref.elementId);
		},
		async snapshotBase64(maxWidth) {
			const blob = await editor.renderer.captureSnapshotBlob();
			if (!blob) return null;
			const bitmap = await createImageBitmap(blob);
			try {
				const scale = Math.min(1, maxWidth / bitmap.width);
				const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
				const ctx = canvas.getContext("2d");
				if (!ctx) return null;
				ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				const png = await canvas.convertToBlob({ type: "image/png" });
				const bytes = new Uint8Array(await png.arrayBuffer());
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
				return btoa(binary);
			} finally {
				bitmap.close();
			}
		},
		addAsset({ assetId, startSeconds, trackId }) {
			const asset = editor.media.getAssets().find((candidate) => candidate.id === assetId);
			if (!asset) throw new McpToolError("There is no asset with that id in the library.");
			const element = buildElementFromMedia({
				mediaId: asset.id,
				mediaType: asset.type,
				name: asset.name,
				duration: asset.duration != null ? toTime(asset.duration) : DEFAULT_NEW_ELEMENT_DURATION,
				startTime: startSeconds !== undefined ? toTime(startSeconds) : editor.playback.getCurrentTime(),
			});
			if (trackId !== undefined && !findTrackInSceneTracks({ tracks: tracksOf({ editor }), trackId })) {
				throw new McpToolError("There is no track with that id.");
			}
			editor.timeline.insertElement({ element, placement: trackId !== undefined ? { mode: "explicit", trackId } : { mode: "auto" } });
			return { elementId: null };
		},
		splitAt({ seconds, elementId }) {
			const tracks = tracksOf({ editor });
			const splitTime = toTime(seconds);
			let targets: Array<{ trackId: string; elementId: string }>;
			if (elementId !== undefined) {
				const { trackId } = find({ editor, elementId });
				targets = [{ trackId, elementId }];
			} else {
				const selected = editor.selection.getSelectedElements();
				targets = selected.length > 0 ? selected : getElementsAtTime({ tracks, time: splitTime });
			}
			if (targets.length === 0) throw new McpToolError("There is no clip under that time to cut.");
			return editor.timeline.splitElements({ elements: targets, splitTime }).length;
		},
		deleteElement(elementId) {
			const { trackId } = find({ editor, elementId });
			editor.timeline.deleteElements({ elements: [{ trackId, elementId }] });
		},
		moveElement({ elementId, startSeconds, trackId }) {
			const { trackId: sourceTrackId } = find({ editor, elementId });
			if (trackId !== undefined && !findTrackInSceneTracks({ tracks: tracksOf({ editor }), trackId })) {
				throw new McpToolError("There is no track with that id.");
			}
			editor.timeline.moveElements({ moves: [{ sourceTrackId, targetTrackId: trackId ?? sourceTrackId, elementId, newStartTime: toTime(startSeconds) }] });
		},
		setProperty({ elementId, property, value }) {
			const { trackId, element } = find({ editor, elementId });
			const param = getElementParam({ element, key: property });
			if (!param) throw new McpToolError("That clip has no property with that name.");
			const coerced = coerceParamValue({ param, value });
			if (coerced === null) throw new McpToolError("That value does not fit the property.");
			const updated = writeElementParamValue({ element, param, value: coerced });
			editor.timeline.updateElements({ updates: [{ trackId, elementId, patch: { params: updated.params } }] });
		},
		addKeyframe({ elementId, property, seconds, value }) {
			const { trackId, element } = find({ editor, elementId });
			const target = resolveAnimationTarget({ element, path: property });
			if (!target) throw new McpToolError("That property cannot be keyframed on this clip.");
			if (target.coerceValue({ value }) === null) throw new McpToolError("That value does not fit the property.");
			if (toTime(seconds) > element.duration) throw new McpToolError("That time is after the end of the clip.");
			editor.timeline.upsertKeyframes({ keyframes: [{ trackId, elementId, propertyPath: property, time: toTime(seconds), value }] });
		},
		applyPreset({ elementId, presetId, placement, seconds }) {
			if (!isPresetId(presetId)) throw new McpToolError("Unknown preset.");
			if (placement !== undefined && !isPlacement(placement)) throw new McpToolError("Unknown placement.");
			const { trackId } = find({ editor, elementId });
			const definition = KEYFRAME_PRESET_DEFINITIONS.find((candidate) => candidate.id === presetId);
			try {
				editor.timeline.applyKeyframePreset({
					targets: [{ trackId, elementId }],
					presetId,
					placement: placement ?? definition?.defaultPlacement ?? "playhead",
					seconds: seconds ?? definition?.defaultSeconds ?? 1,
				});
			} catch {
				throw new McpToolError("That preset does not fit this clip.");
			}
		},
		setText({ elementId, text }) {
			const { trackId, element } = find({ editor, elementId });
			if (element.type !== "text") throw new McpToolError("That clip is not a text clip.");
			editor.timeline.updateElements({ updates: [{ trackId, elementId, patch: { params: { ...element.params, content: text } } }] });
		},
		seek(seconds) {
			editor.playback.seek({ time: toTime(seconds) });
		},
		play() {
			editor.playback.play();
		},
		pause() {
			editor.playback.pause();
		},
	};
}
