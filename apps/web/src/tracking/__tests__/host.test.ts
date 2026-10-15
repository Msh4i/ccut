import { describe, expect, test } from "bun:test";
import type {
	SceneTracks,
	TextElement,
	TimelineElement,
	VideoElement,
} from "@/timeline";
import {
	buildHostBoundsAt,
	findElementInTracks,
	trackedSourceStart,
	type HostBoundsClip,
	type HostTimingClip,
} from "@/tracking/host";
import { mediaTimeFromSeconds } from "@/wasm";

function sec(seconds: number) {
	return mediaTimeFromSeconds({ seconds });
}

function timing({
	start = 4,
	duration = 10,
	trimStart = 1,
	rate,
	mediaId = "media-1",
}: {
	start?: number;
	duration?: number;
	trimStart?: number;
	rate?: number;
	mediaId?: string;
} = {}): HostTimingClip {
	return {
		mediaId,
		startTime: sec(start),
		duration: sec(duration),
		trimStart: sec(trimStart),
		retime: rate === undefined ? undefined : { rate },
	};
}

describe("trackedSourceStart", () => {
	test("is where in the source media the first sample was taken", () => {
		expect(
			trackedSourceStart({ host: timing({ trimStart: 1 }), clipStartSec: 2 }),
		).toBeCloseTo(3, 6);
		expect(
			trackedSourceStart({
				host: timing({ trimStart: 1, rate: 2 }),
				clipStartSec: 2,
			}),
		).toBeCloseTo(5, 6);
	});
});

function videoElement({ id }: { id: string }): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "media-1",
		duration: sec(10),
		startTime: sec(0),
		trimStart: sec(0),
		trimEnd: sec(0),
		params: {},
	};
}

function textElement({ id }: { id: string }): TextElement {
	return {
		id,
		name: id,
		type: "text",
		duration: sec(2),
		startTime: sec(0),
		trimStart: sec(0),
		trimEnd: sec(0),
		params: {},
	};
}

function tracksWith({
	main,
	overlay,
}: {
	main: VideoElement[];
	overlay: Array<{ id: string; elements: TimelineElement[] }>;
}): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: main,
		},
		overlay: overlay.map(({ id, elements }) => ({
			id,
			name: id,
			type: "video",
			muted: false,
			hidden: false,
			elements: elements.filter(
				(element) => element.type === "video" || element.type === "image",
			),
		})),
		audio: [],
	};
}

describe("findElementInTracks", () => {
	test("finds a clip on the main track and says which track it is on", () => {
		const tracks = tracksWith({
			main: [videoElement({ id: "a" })],
			overlay: [],
		});
		const found = findElementInTracks({ tracks, elementId: "a" });
		expect(found?.trackId).toBe("main");
		expect(found?.element.id).toBe("a");
	});

	test("follows a clip dragged to another track", () => {
		const element = videoElement({ id: "a" });
		const before = tracksWith({
			main: [],
			overlay: [{ id: "overlay-1", elements: [element] }],
		});
		const after = tracksWith({
			main: [],
			overlay: [
				{ id: "overlay-1", elements: [] },
				{ id: "overlay-2", elements: [element] },
			],
		});
		expect(
			findElementInTracks({ tracks: before, elementId: "a" })?.trackId,
		).toBe("overlay-1");
		expect(
			findElementInTracks({ tracks: after, elementId: "a" })?.trackId,
		).toBe("overlay-2");
	});

	test("finds elements on text and graphic tracks too", () => {
		const tracks: SceneTracks = {
			main: {
				id: "main",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [],
			},
			overlay: [
				{
					id: "text-1",
					name: "Text",
					type: "text",
					hidden: false,
					elements: [textElement({ id: "t" })],
				},
			],
			audio: [],
		};
		expect(findElementInTracks({ tracks, elementId: "t" })?.trackId).toBe(
			"text-1",
		);
	});

	test("an unknown or removed clip gives null", () => {
		const tracks = tracksWith({
			main: [videoElement({ id: "a" })],
			overlay: [],
		});
		expect(findElementInTracks({ tracks, elementId: "gone" })).toBeNull();
	});
});

describe("buildHostBoundsAt", () => {
	function host(overrides: Partial<HostBoundsClip> = {}): HostBoundsClip {
		return {
			...timing({ start: 2, duration: 10, trimStart: 0 }),
			params: {},
			...overrides,
		};
	}
	const canvas = { canvasWidth: 1920, canvasHeight: 1080 };
	const source = { sourceWidth: 1920, sourceHeight: 1080 };

	function boundsAt({
		clip,
		seconds,
	}: {
		clip: HostBoundsClip;
		seconds: number;
	}) {
		return buildHostBoundsAt({ host: clip, ...canvas, ...source })(seconds);
	}

	test("a plain host fills the canvas", () => {
		const bounds = boundsAt({ clip: host(), seconds: 5 });
		expect(bounds.cx).toBeCloseTo(960, 9);
		expect(bounds.cy).toBeCloseTo(540, 9);
		expect(bounds.width).toBeCloseTo(1920, 9);
		expect(bounds.height).toBeCloseTo(1080, 9);
		expect(bounds.rotation).toBe(0);
	});

	test("follows the host's own transform and animation", () => {
		const clip = host({
			params: { "transform.scaleX": 0.5, "transform.scaleY": 0.5 },
			animations: {
				"transform.positionX": {
					keys: [
						{
							id: "a",
							time: sec(0),
							value: 0,
							segmentToNext: "linear",
							tangentMode: "flat",
						},
						{
							id: "b",
							time: sec(4),
							value: 400,
							segmentToNext: "linear",
							tangentMode: "flat",
						},
					],
				},
			},
		});
		const bounds = boundsAt({ clip, seconds: 4 });
		expect(bounds.width).toBeCloseTo(960, 9);
		expect(bounds.cx).toBeCloseTo(960 + 200, 6);
	});

	test("a fade In does not move the picture", () => {
		const rest = boundsAt({ clip: host(), seconds: 8 });
		const clip = host({
			presetAnimations: { in: { id: "fade", duration: sec(1) } },
		});
		const during = boundsAt({ clip, seconds: 2.25 });
		expect(during.cx).toBeCloseTo(rest.cx, 9);
		expect(during.width).toBeCloseTo(rest.width, 9);
	});

	test("a slide In puts the picture off to the side until it has arrived", () => {
		const clip = host({
			presetAnimations: { in: { id: "slide-left", duration: sec(1) } },
		});
		const rest = boundsAt({ clip, seconds: 8 });
		const first = boundsAt({ clip, seconds: 2 });
		const halfway = boundsAt({ clip, seconds: 2.5 });
		const arrived = boundsAt({ clip, seconds: 3 });
		expect(first.cx).toBeLessThan(halfway.cx);
		expect(halfway.cx).toBeLessThan(rest.cx);
		expect(arrived.cx).toBeCloseTo(rest.cx, 6);
	});

	test("a zoom In grows the picture from half size", () => {
		const clip = host({
			presetAnimations: { in: { id: "zoom", duration: sec(1) } },
		});
		const rest = boundsAt({ clip, seconds: 8 });
		const first = boundsAt({ clip, seconds: 2 });
		const arrived = boundsAt({ clip, seconds: 3 });
		expect(first.width).toBeCloseTo(rest.width / 2, 6);
		expect(first.height).toBeCloseTo(rest.height / 2, 6);
		expect(first.cx).toBeCloseTo(rest.cx, 6);
		expect(arrived.width).toBeCloseTo(rest.width, 6);
	});

	test("an Out preset moves the picture at the end of the clip", () => {
		const clip = host({
			presetAnimations: { out: { id: "slide-right", duration: sec(1) } },
		});
		const rest = boundsAt({ clip, seconds: 6 });
		const leaving = boundsAt({ clip, seconds: 11.75 });
		expect(leaving.cx).toBeGreaterThan(rest.cx);
	});

	test("uses the media's own size to fit the picture in the canvas", () => {
		const bounds = buildHostBoundsAt({
			host: host(),
			...canvas,
			sourceWidth: 1080,
			sourceHeight: 1920,
		})(5);
		// a portrait clip is contained: full height, 607.5 wide
		expect(bounds.height).toBeCloseTo(1080, 6);
		expect(bounds.width).toBeCloseTo(607.5, 6);
	});
});
