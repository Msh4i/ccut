import type { VideoFileData } from "./video-probe";

export interface ImportNotice {
	level: "error" | "warning";
	title: string;
	description: string;
}

function unsupportedVideoDescription({
	codec,
}: {
	codec: VideoFileData["codec"];
}): string {
	const codecLabel = codec ? codec.toUpperCase() : "this video codec";

	return codec === "hevc"
		? `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 or try importing it in Safari.`
		: `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 and reimport it.`;
}

/** What the import tells the user about a video that was read. */
export function videoImportNotices({
	fileName,
	video,
}: {
	fileName: string;
	video: Pick<VideoFileData, "codec" | "canDecode" | "previewIssue">;
}): ImportNotice[] {
	if (video.canDecode === false) {
		return [
			{
				level: "error",
				title: `Can't preview ${fileName}`,
				description: unsupportedVideoDescription({ codec: video.codec }),
			},
		];
	}
	if (video.previewIssue === null) {
		return [];
	}
	return [
		{
			level: "warning",
			title: `No thumbnail for ${fileName}`,
			description:
				video.previewIssue === "timeout"
					? "Decoding the first frame took too long, so the clip was imported without a thumbnail."
					: "The first frame could not be decoded, so the clip was imported without a thumbnail.",
		},
	];
}
