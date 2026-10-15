import { describe, expect, test } from "bun:test";
import {
	EXPORT_ERROR_CODES,
	ExportError,
	createAacUnavailableError,
	createAudioTooShortError,
	createAudioUnreadableError,
	createFileErrorFor,
	createTooLargeForMemoryError,
	isExportError,
} from "../errors";

describe("ExportError", () => {
	test("is a real Error that carries its code, technical detail and cause", () => {
		const cause = new Error("root");
		const error = new ExportError({
			code: "AAC_UNAVAILABLE",
			message: "what the user reads",
			detail: "what support reads",
			cause,
		});

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ExportError");
		expect(error.message).toBe("what the user reads");
		expect(error.code).toBe("AAC_UNAVAILABLE");
		expect(error.detail).toBe("what support reads");
		expect(error.cause).toBe(cause);
	});

	test("isExportError tells it from other errors and from non-errors", () => {
		expect(isExportError(createAacUnavailableError({ stage: "x" }))).toBe(true);
		expect(isExportError(new Error("plain"))).toBe(false);
		expect(isExportError({ code: "AAC_UNAVAILABLE" })).toBe(false);
		expect(isExportError(null)).toBe(false);
		expect(isExportError(undefined)).toBe(false);
	});

	test("lists only codes that something throws", () => {
		expect([...EXPORT_ERROR_CODES]).toEqual([
			"AAC_UNAVAILABLE",
			"AUDIO_UNREADABLE",
			"AUDIO_TOO_SHORT",
			"EXPORT_BUSY",
			"DISK_FULL",
			"WRITE_FAILED",
			"VERIFY_FAILED",
			"SESSION_EXPIRED",
			"NAME_TOO_LONG",
			"TOO_LARGE_FOR_MEMORY",
		]);
	});
});

describe("createAacUnavailableError", () => {
	test("tells the user what to do instead and names the code and failing stage", () => {
		const error = createAacUnavailableError({ stage: "trial encode", cause: new Error("worker blocked") });

		expect(error.code).toBe("AAC_UNAVAILABLE");
		expect(error.message).toBe(
			"The AAC audio encoder could not start, so the MP4 was not exported. " +
				'Export as WebM (Opus audio), or turn off "Include audio" and export again. ' +
				"Details: AAC_UNAVAILABLE, trial encode: worker blocked",
		);
		expect(error.detail).toBe("trial encode: worker blocked");
	});

	test("describes the cause whatever it is: Error, empty-message Error, string, other, none", () => {
		const detailFor = (cause: unknown) => createAacUnavailableError({ stage: "s", cause }).detail;

		expect(detailFor(new Error("boom"))).toBe("s: boom");
		expect(detailFor(new TypeError(""))).toBe("s: TypeError");
		expect(detailFor("text cause")).toBe("s: text cause");
		expect(detailFor({ weird: true })).toBe("s: [object Object]");
		expect(detailFor(404)).toBe("s: 404");
		expect(detailFor(null)).toBe("s: null");
		expect(createAacUnavailableError({ stage: "no cause given" }).detail).toBe("no cause given");
	});
});

describe("createAudioUnreadableError", () => {
	test("names the one clip and tells the user to remove or re-add it, or to turn the audio off", () => {
		const error = createAudioUnreadableError({
			skipped: [{ name: "interview.mp4", reason: "Unable to decode audio data" }],
		});

		expect(error.code).toBe("AUDIO_UNREADABLE");
		expect(error.message).toBe(
			'Audio of "interview.mp4" could not be read, so it would be silent in the exported file. ' +
				'Remove or re-add it, or turn off "Include audio" and export again. ' +
				"Details: AUDIO_UNREADABLE, interview.mp4: Unable to decode audio data",
		);
		expect(error.detail).toBe("interview.mp4: Unable to decode audio data");
	});

	test("says 'them' for several clips, lists each name once, caps the list at 5 and counts the rest", () => {
		const skipped = ["a", "b", "a", "c", "d", "e", "f", "g"].map((name) => ({ name, reason: "bad" }));

		const error = createAudioUnreadableError({ skipped });

		expect(error.message).toContain('Audio of "a", "b", "c", "d", "e" and 2 more could not be read');
		expect(error.message).toContain("Remove or re-add them");
		expect(error.detail).toBe("a: bad; b: bad; a: bad; c: bad; d: bad; e: bad; f: bad; g: bad");
	});

	test("with nothing named, it says that none of the project's audio could be read", () => {
		const error = createAudioUnreadableError({ skipped: [] });

		expect(error.code).toBe("AUDIO_UNREADABLE");
		expect(error.message).toContain("None of the project's audio could be read");
		expect(error.message).toContain('turn off "Include audio"');
		expect(error.detail).toBe("the audio mix is empty");
	});
});

describe("createAudioTooShortError", () => {
	test("says why a mix of 1024 samples or fewer cannot be an AAC track, and what to do", () => {
		const error = createAudioTooShortError({ samples: 735, sampleRate: 44100 });

		expect(error.code).toBe("AUDIO_TOO_SHORT");
		expect(error.message).toBe(
			"The audio is no longer than one AAC frame (1024 samples, 23 ms), too short to encode as AAC, so the MP4 was not exported. " +
				'Lengthen the project or turn off "Include audio". ' +
				"Details: AUDIO_TOO_SHORT, 735 samples at 44100 Hz",
		);
		expect(error.detail).toBe("735 samples at 44100 Hz");
	});
});

describe("file errors (export to disk)", () => {
	test("each code has its own message, with the code in the copyable details and no path", () => {
		const messages = new Set<string>();
		for (const code of ["EXPORT_BUSY", "DISK_FULL", "WRITE_FAILED", "VERIFY_FAILED", "SESSION_EXPIRED", "NAME_TOO_LONG"] as const) {
			const error = createFileErrorFor({ code, detail: "CCUT_EXPORT:X" });
			expect(error.code).toBe(code);
			expect(error.message).toContain(`Details: ${code}`);
			expect(error.detail).toBe("CCUT_EXPORT:X");
			messages.add(error.message);
		}
		expect(messages.size).toBe(6);
		expect(createFileErrorFor({ code: "DISK_FULL", detail: "" }).message).toMatch(/disk is full/i);
		expect(createFileErrorFor({ code: "EXPORT_BUSY", detail: "" }).message).toMatch(/already/i);
		expect(createFileErrorFor({ code: "SESSION_EXPIRED", detail: "" }).message).toBe(
			"The export session expired or was closed. Start the export again. Details: SESSION_EXPIRED",
		);
		expect(createFileErrorFor({ code: "NAME_TOO_LONG", detail: "name-too-long" }).message).toMatch(/file name is too long.*shorter name/i);
	});

	test("too large for memory names the estimate and the limit in GiB", () => {
		const error = createTooLargeForMemoryError({ estimatedBytes: 5 * 2 ** 30, limitBytes: 3 * 2 ** 30 });
		expect(error.code).toBe("TOO_LARGE_FOR_MEMORY");
		expect(error.message).toContain("5.0 GiB");
		expect(error.message).toContain("3.0 GiB");
	});
});
