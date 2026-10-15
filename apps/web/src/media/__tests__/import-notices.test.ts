import { describe, expect, test } from "bun:test";
import { videoImportNotices } from "../import-notices";

const base = {
	codec: "avc" as const,
	canDecode: true as boolean | null,
	previewIssue: null as "timeout" | "error" | null,
};

describe("videoImportNotices", () => {
	test("a decodable video with a thumbnail gets no notice", () => {
		expect(videoImportNotices({ fileName: "a.mp4", video: base })).toEqual([]);
	});

	test("an undecodable codec keeps the existing error (HEVC hint)", () => {
		const notices = videoImportNotices({
			fileName: "a.mov",
			video: { ...base, codec: "hevc", canDecode: false },
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", title: "Can't preview a.mov" });
		expect(notices[0].description).toContain("Safari");
	});

	test("an unknown decodability answer is not reported as undecodable", () => {
		const notices = videoImportNotices({
			fileName: "a.mp4",
			video: { ...base, canDecode: null, previewIssue: "timeout" },
		});
		expect(notices.map((notice) => notice.level)).toEqual(["warning"]);
	});

	test("a thumbnail timeout says the clip was imported without a thumbnail", () => {
		const [notice] = videoImportNotices({
			fileName: "a.mp4",
			video: { ...base, previewIssue: "timeout" },
		});
		expect(notice.level).toBe("warning");
		expect(notice.title).toBe("No thumbnail for a.mp4");
		expect(notice.description).toContain("took too long");
	});

	test("a thumbnail decode error says the same with its own reason", () => {
		const [notice] = videoImportNotices({
			fileName: "a.mp4",
			video: { ...base, previewIssue: "error" },
		});
		expect(notice.level).toBe("warning");
		expect(notice.description).toContain("could not be decoded");
	});
});
