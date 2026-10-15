import { describe, expect, test } from "bun:test";
import {
	QUALITY_HIGH,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import { EXPORT_QUALITY_VALUES, type ExportQuality } from "@/export";
import {
	AAC_VALID_BITRATES,
	audioBitrateFor,
	selectAudioCodec,
} from "../audio-codec";

describe("selectAudioCodec", () => {
	test("mp4 is AAC when the encoder works, and audio-off (null) when it does not: never opus", () => {
		expect(selectAudioCodec({ container: "mp4", aacAvailable: true })).toBe("aac");
		expect(selectAudioCodec({ container: "mp4", aacAvailable: false })).toBeNull();
	});

	test("webm is always opus, whatever AAC availability says", () => {
		expect(selectAudioCodec({ container: "webm", aacAvailable: true })).toBe("opus");
		expect(selectAudioCodec({ container: "webm", aacAvailable: false })).toBe("opus");
	});

	test("an mp4 never receives opus, for any availability", () => {
		for (const aacAvailable of [true, false]) {
			expect(selectAudioCodec({ container: "mp4", aacAvailable })).not.toBe("opus");
		}
	});
});

describe("audioBitrateFor", () => {
	test("every AAC bitrate is one mediabunny accepts (96/128/160/192 kb/s), for every quality", () => {
		expect([...AAC_VALID_BITRATES]).toEqual([96_000, 128_000, 160_000, 192_000]);
		for (const quality of EXPORT_QUALITY_VALUES) {
			expect(AAC_VALID_BITRATES).toContain(audioBitrateFor({ codec: "aac", quality }));
		}
	});

	test("a higher quality never gets a lower bitrate", () => {
		for (const codec of ["aac", "opus"] as const) {
			const rates = EXPORT_QUALITY_VALUES.map((quality) => audioBitrateFor({ codec, quality }));
			expect(rates).toEqual([...rates].sort((a, b) => a - b));
		}
	});

	test("matches what mediabunny's own quality mapping yields for the pinned version (drift guard)", () => {
		const qualities: Record<ExportQuality, object> = {
			low: QUALITY_LOW,
			medium: QUALITY_MEDIUM,
			high: QUALITY_HIGH,
			very_high: QUALITY_VERY_HIGH,
		};
		for (const codec of ["aac", "opus"] as const) {
			for (const quality of EXPORT_QUALITY_VALUES) {
				const target = qualities[quality];
				const method: unknown = Reflect.get(target, "_toAudioBitrate");
				if (typeof method !== "function") {
					throw new Error("mediabunny no longer has Quality._toAudioBitrate: re-derive the table");
				}
				expect(audioBitrateFor({ codec, quality })).toBe(Reflect.apply(method, target, [codec]));
			}
		}
	});
});
