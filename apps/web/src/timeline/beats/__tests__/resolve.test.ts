import { describe, expect, test } from "bun:test";
import { getClipTimeAtSourceTime, getSourceSpanAtClipTime } from "@/retime";
import type { RetimeConfig, UploadAudioElement, VideoElement } from "@/timeline";
import {
	getBeatClipOffsets,
	getBeatTimelineTimes,
	getVisibleSourceBeats,
} from "@/timeline/beats/resolve";
import {
	addMediaTime,
	mediaTime,
	roundMediaTime,
	subMediaTime,
	type MediaTime,
} from "@/wasm";

const SECOND = 120000;

function ticks(values: number[]): MediaTime[] {
	return values.map((ticks) => mediaTime({ ticks }));
}

function buildAudio(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		id: "audio-1",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		name: "Song",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 10 * SECOND }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
		...overrides,
	};
}

// Same arithmetic as SplitElementsCommand: snap the source span once, derive
// the right half from it.
function splitElement({
	element,
	relativeTime,
}: {
	element: UploadAudioElement;
	relativeTime: MediaTime;
}): { left: UploadAudioElement; right: UploadAudioElement } {
	const leftSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: relativeTime,
			retime: element.retime,
		}),
	});
	return {
		left: { ...element, duration: relativeTime },
		right: {
			...element,
			startTime: addMediaTime({ a: element.startTime, b: relativeTime }),
			duration: subMediaTime({ a: element.duration, b: relativeTime }),
			trimStart: addMediaTime({ a: element.trimStart, b: leftSourceSpan }),
		},
	};
}

describe("getBeatClipOffsets", () => {
	test("returns nothing when the element was never analysed", () => {
		expect(getBeatClipOffsets({ element: buildAudio() })).toEqual([]);
	});

	test("returns nothing for an empty beat list", () => {
		expect(getBeatClipOffsets({ element: buildAudio({ beats: [] }) })).toEqual(
			[],
		);
	});

	test("keeps every beat of an untrimmed clip, as ticks from the clip start", () => {
		const element = buildAudio({ beats: ticks([0, SECOND, 2 * SECOND]) });
		expect(getBeatClipOffsets({ element })).toEqual(
			ticks([0, SECOND, 2 * SECOND]),
		);
	});

	test("drops beats before the trim start and re-bases the rest on it", () => {
		const element = buildAudio({
			trimStart: mediaTime({ ticks: 2 * SECOND }),
			duration: mediaTime({ ticks: 4 * SECOND }),
			beats: ticks([SECOND, 2 * SECOND, 3 * SECOND, 5 * SECOND]),
		});
		expect(getBeatClipOffsets({ element })).toEqual(ticks([0, SECOND, 3 * SECOND]));
	});

	test("the visible window is half open: a beat exactly at the end is dropped", () => {
		const element = buildAudio({
			trimStart: mediaTime({ ticks: SECOND }),
			duration: mediaTime({ ticks: 2 * SECOND }),
			beats: ticks([SECOND, 2 * SECOND, 3 * SECOND, 4 * SECOND]),
		});
		expect(getBeatClipOffsets({ element })).toEqual(ticks([0, SECOND]));
	});

	test("is independent of startTime", () => {
		const beats = ticks([SECOND, 3 * SECOND]);
		const a = buildAudio({ beats, startTime: mediaTime({ ticks: 0 }) });
		const b = buildAudio({ beats, startTime: mediaTime({ ticks: 50 * SECOND }) });
		expect(getBeatClipOffsets({ element: b })).toEqual(
			getBeatClipOffsets({ element: a }),
		);
	});

	test("2x speed halves the distance between beats", () => {
		const retime: RetimeConfig = { rate: 2 };
		const element = buildAudio({
			retime,
			duration: mediaTime({ ticks: 5 * SECOND }),
			beats: ticks([0, 2 * SECOND, 4 * SECOND, 9 * SECOND, 10 * SECOND]),
		});
		// 5 s of clip at 2x covers 10 s of source: the beat at 10 s is outside.
		expect(getBeatClipOffsets({ element })).toEqual(
			ticks([0, SECOND, 2 * SECOND, 4.5 * SECOND]),
		);
	});

	test("0.5x speed doubles the distance between beats", () => {
		const retime: RetimeConfig = { rate: 0.5 };
		const element = buildAudio({
			retime,
			duration: mediaTime({ ticks: 8 * SECOND }),
			beats: ticks([0, SECOND, 2 * SECOND, 4 * SECOND, 5 * SECOND]),
		});
		// 8 s of clip at 0.5x covers 4 s of source: beats at 4 s and 5 s are outside.
		expect(getBeatClipOffsets({ element })).toEqual(
			ticks([0, 2 * SECOND, 4 * SECOND]),
		);
	});

	test("rounds fractional clip times to whole ticks", () => {
		const element = buildAudio({
			retime: { rate: 3 },
			duration: mediaTime({ ticks: 100 }),
			beats: ticks([10, 11, 13]),
		});
		const offsets = getBeatClipOffsets({ element });
		expect(offsets).toEqual(ticks([3, 4, 4]));
		for (const offset of offsets) {
			expect(Number.isInteger(offset)).toBe(true);
		}
	});

	test("works on a video element", () => {
		const video: VideoElement = {
			id: "video-1",
			type: "video",
			mediaId: "media-1",
			name: "Clip",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 3 * SECOND }),
			trimStart: mediaTime({ ticks: SECOND }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
			beats: ticks([SECOND, 2 * SECOND, 5 * SECOND]),
		};
		expect(getBeatClipOffsets({ element: video })).toEqual(ticks([0, SECOND]));
	});

	test("a video with separated audio shows none: the extracted clip owns them", () => {
		const video: VideoElement = {
			id: "video-1",
			type: "video",
			mediaId: "media-1",
			name: "Clip",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 3 * SECOND }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
			beats: ticks([SECOND]),
			isSourceAudioEnabled: false,
		};
		expect(getBeatClipOffsets({ element: video })).toEqual([]);
		expect(
			getBeatClipOffsets({ element: { ...video, isSourceAudioEnabled: true } }),
		).toEqual(ticks([SECOND]));
	});

	test("never mutates the stored beat array", () => {
		const beats = ticks([0, SECOND, 9 * SECOND]);
		Object.freeze(beats);
		const element = buildAudio({
			trimStart: mediaTime({ ticks: SECOND }),
			duration: mediaTime({ ticks: 2 * SECOND }),
			beats,
		});
		getBeatClipOffsets({ element });
		expect(beats).toEqual(ticks([0, SECOND, 9 * SECOND]));
	});
});

describe("getBeatClipOffsets against stored garbage", () => {
	function withRawBeats(raw: unknown): UploadAudioElement {
		const element = buildAudio();
		Reflect.set(element, "beats", raw);
		return element;
	}

	test("never throws and keeps only the usable beats", () => {
		const element = withRawBeats([
			Number.NaN,
			"x",
			2 * SECOND,
			SECOND,
			SECOND,
			-5,
			1.5,
			null,
		]);
		expect(getBeatClipOffsets({ element })).toEqual(ticks([SECOND, 2 * SECOND]));
		expect(getBeatTimelineTimes({ element })).toEqual(
			ticks([SECOND, 2 * SECOND]),
		);
	});

	test("a beats value that is not an array shows no beats", () => {
		for (const raw of ["abc", 12, { length: 2, 0: 1, 1: 2 }, true]) {
			expect(getBeatClipOffsets({ element: withRawBeats(raw) })).toEqual([]);
		}
	});

	test("an oversized list is trimmed instead of flooding the timeline", () => {
		const raw = Array.from({ length: 30_000 }, (_, i) => i);
		const element = buildAudio({
			duration: mediaTime({ ticks: 100_000 }),
			beats: ticks(raw),
		});
		expect(getBeatClipOffsets({ element }).length).toBe(20_000);
	});
});

describe("getBeatClipOffsets window search", () => {
	// The straightforward filter the binary search must agree with.
	function naiveOffsets(element: UploadAudioElement): MediaTime[] {
		const end =
			element.trimStart +
			roundMediaTime({
				time: getSourceSpanAtClipTime({
					clipTime: element.duration,
					retime: element.retime,
				}),
			});
		return (element.beats ?? [])
			.filter((beat) => beat >= element.trimStart && beat < end)
			.map((beat) =>
				roundMediaTime({
					time: getClipTimeAtSourceTime({
						sourceTime: beat - element.trimStart,
						retime: element.retime,
					}),
				}),
			);
	}

	test("matches a plain filter for many random trims, speeds and windows", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 4294967296;
		};
		const beats = ticks(
			Array.from({ length: 2000 }, (_, i) => 500 + i * 1300 + Math.floor(random() * 400)),
		);
		for (let i = 0; i < 300; i++) {
			const rate = [undefined, 0.5, 2, 1.25][Math.floor(random() * 4)];
			const element = buildAudio({
				beats,
				retime: rate === undefined ? undefined : { rate },
				trimStart: mediaTime({ ticks: Math.floor(random() * 2_000_000) }),
				duration: mediaTime({ ticks: 1 + Math.floor(random() * 1_500_000) }),
			});
			expect(getBeatClipOffsets({ element })).toEqual(naiveOffsets(element));
		}
	});

	test("repeated calls for the same clip reuse the computed offsets", () => {
		const element = buildAudio({ beats: ticks([0, SECOND, 2 * SECOND]) });
		expect(getBeatClipOffsets({ element })).toBe(getBeatClipOffsets({ element }));
	});

	test("an edited clip is recomputed, not served stale", () => {
		const element = buildAudio({ beats: ticks([0, SECOND, 2 * SECOND]) });
		const trimmed = { ...element, trimStart: mediaTime({ ticks: SECOND }) };
		expect(getBeatClipOffsets({ element })).toEqual(
			ticks([0, SECOND, 2 * SECOND]),
		);
		expect(getBeatClipOffsets({ element: trimmed })).toEqual(
			ticks([0, SECOND]),
		);
	});
});

describe("getBeatTimelineTimes", () => {
	test("adds the clip start to every offset", () => {
		const element = buildAudio({
			startTime: mediaTime({ ticks: 7 * SECOND }),
			beats: ticks([0, SECOND, 2 * SECOND]),
		});
		expect(getBeatTimelineTimes({ element })).toEqual(
			ticks([7 * SECOND, 8 * SECOND, 9 * SECOND]),
		);
	});

	test("moving the clip shifts every beat by the same amount", () => {
		const beats = ticks([SECOND / 3, SECOND, 4 * SECOND + 17]);
		const before = getBeatTimelineTimes({
			element: buildAudio({ beats, startTime: mediaTime({ ticks: 2 * SECOND }) }),
		});
		const after = getBeatTimelineTimes({
			element: buildAudio({ beats, startTime: mediaTime({ ticks: 9 * SECOND }) }),
		});
		expect(after.map((time, i) => time - before[i])).toEqual(
			before.map(() => 7 * SECOND),
		);
	});

	test("trimming the start does not move the surviving beats on the timeline", () => {
		// Trimming the left edge moves startTime forward by the trimmed span.
		const beats = ticks([SECOND, 2 * SECOND, 3 * SECOND]);
		const full = getBeatTimelineTimes({
			element: buildAudio({ beats, startTime: mediaTime({ ticks: 4 * SECOND }) }),
		});
		const trimmed = getBeatTimelineTimes({
			element: buildAudio({
				beats,
				startTime: mediaTime({ ticks: 5 * SECOND }),
				trimStart: mediaTime({ ticks: SECOND }),
				duration: mediaTime({ ticks: 9 * SECOND }),
			}),
		});
		expect(trimmed).toEqual(full);
	});
});

describe("split invariance", () => {
	test("a beat on a half-tick boundary at 2x lands in exactly one half", () => {
		const element = buildAudio({
			retime: { rate: 2 },
			duration: mediaTime({ ticks: 1000 }),
			// Split at clip tick 100 = source tick 200; the beat at source tick
			// 199 maps to clip tick 99.5, which rounds to 100.
			beats: ticks([199]),
		});
		const { left, right } = splitElement({
			element,
			relativeTime: mediaTime({ ticks: 100 }),
		});
		expect(getBeatClipOffsets({ element: left })).toEqual(ticks([100]));
		expect(getBeatClipOffsets({ element: right })).toEqual([]);
	});

	const beats = Array.from({ length: 40 }, (_, i) =>
		mediaTime({ ticks: 12345 + i * 44111 }),
	);
	const rates = [undefined, 0.5, 2, 1.5, 0.3, 4.7];
	const splitTicks = [1, 55555, 5 * SECOND, 123457, 9 * SECOND + 3];

	for (const rate of rates) {
		test(`both halves share the original beats exactly once (rate ${rate ?? "none"})`, () => {
			const retime = rate === undefined ? undefined : { rate };
			const duration =
				rate === undefined
					? mediaTime({ ticks: 20 * SECOND })
					: roundMediaTime({ time: (20 * SECOND) / rate });
			const element = buildAudio({
				retime,
				duration,
				trimStart: mediaTime({ ticks: 20000 }),
				startTime: mediaTime({ ticks: 3 * SECOND }),
				beats,
			});
			const original = getBeatTimelineTimes({ element });

			for (const at of splitTicks) {
				if (at >= duration) continue;
				const { left, right } = splitElement({
					element,
					relativeTime: mediaTime({ ticks: at }),
				});
				const leftTimes = getBeatTimelineTimes({ element: left });
				const rightTimes = getBeatTimelineTimes({ element: right });

				expect(leftTimes.length + rightTimes.length).toBe(original.length);
				const merged = [...leftTimes, ...rightTimes];
				for (let i = 0; i < merged.length; i++) {
					// The right half re-bases on a rounded source span, so a beat may
					// land up to one source tick (in clip ticks) from where the
					// unsplit clip put it.
					expect(Math.abs(merged[i] - original[i])).toBeLessThanOrEqual(
						Math.ceil(1 / (rate ?? 1)),
					);
				}
				for (const time of leftTimes) {
					expect(time).toBeLessThanOrEqual(left.startTime + left.duration);
				}
				for (const time of rightTimes) {
					expect(time).toBeGreaterThanOrEqual(right.startTime);
				}
			}
		});
	}
});

describe("getVisibleSourceBeats", () => {
	test("is the stored beat of every offset, item for item, on a trimmed and sped-up clip", () => {
		const stored = ticks([1 * SECOND, 2 * SECOND, 3 * SECOND, 4 * SECOND, 5 * SECOND, 8 * SECOND]);
		const element = buildAudio({
			beats: stored,
			trimStart: mediaTime({ ticks: 2 * SECOND }),
			duration: mediaTime({ ticks: 3 * SECOND }),
			retime: { rate: 2 },
		});
		const sources = getVisibleSourceBeats({ element });
		const offsets = getBeatClipOffsets({ element });
		expect(sources.length).toBe(offsets.length);
		expect(sources.length).toBeGreaterThan(0);
		sources.forEach((source, index) => {
			expect(stored).toContain(source);
			expect(
				roundMediaTime({
					time: getClipTimeAtSourceTime({
						sourceTime: subMediaTime({ a: source, b: element.trimStart }),
						retime: element.retime,
					}),
				}),
			).toBe(offsets[index]);
		});
	});

	test("is empty for a clip that was never analysed", () => {
		expect(getVisibleSourceBeats({ element: buildAudio() })).toEqual([]);
	});

	test("repeated calls for the same clip reuse the list", () => {
		const element = buildAudio({ beats: ticks([SECOND, 2 * SECOND]) });
		expect(getVisibleSourceBeats({ element })).toBe(getVisibleSourceBeats({ element }));
	});
});
