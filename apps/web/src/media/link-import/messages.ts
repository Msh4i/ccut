import type { LinkImportErrorCode } from "./types";

// The oldest yt-dlp the desktop app accepts: MIN_VERSION in apps/electron/link-import-tool.js
// (a test keeps the two equal).
const YT_DLP_MIN_VERSION = "2025.03.21";

export const LINK_IMPORT_MESSAGES: Record<LinkImportErrorCode, string> = {
	invalid: "This request was not accepted. Check the link and the options.",
	"url-refused":
		"Paste the link of a single YouTube or TikTok video. It must start with https://.",
	"playlist-refused":
		"Playlist links are not supported. Open one video and paste its link.",
	busy: "Another link is still being imported. Wait for it or cancel it first.",
	"tool-missing":
		"yt-dlp is not available for this computer. Install yt-dlp so that it is on your PATH, then try again.",
	"consent-declined":
		"yt-dlp was not downloaded, so the link cannot be imported.",
	"tool-download-failed":
		"Downloading yt-dlp failed. Check your internet connection and try again.",
	"tool-verify-failed":
		"The downloaded yt-dlp did not match its published checksum and was deleted. Try again later.",
	"tool-signature-failed":
		"The yt-dlp release could not be verified: its signature does not match the yt-dlp signing key built into Ccut, so nothing was installed. Try again later; if this keeps happening, update Ccut (yt-dlp may have changed its signing key).",
	"tool-outdated": `The yt-dlp on this computer is older than ${YT_DLP_MIN_VERSION} (Ccut needs ${YT_DLP_MIN_VERSION} or newer): update it with your package manager (yt-dlp -U, pip install -U yt-dlp) and try again, or accept Ccut's offer to download its own copy.`,
	"extractor-failed":
		"yt-dlp could not read this video: the site has probably changed and yt-dlp needs an update.",
	"path-tool-stale": `The yt-dlp on this computer could not read this video and is probably out of date: update it with your package manager (yt-dlp -U, pip install -U yt-dlp, brew upgrade yt-dlp) and try again. Ccut does not change a yt-dlp that you installed yourself.`,
	"up-to-date":
		"Ccut's yt-dlp is already the newest release, so updating cannot fix this. The site may have changed: try again after the next yt-dlp release.",
	private: "This video is private.",
	"login-required":
		"This video needs a signed-in account (age check, members only or a bot check). Ccut does not use accounts or cookies, so it cannot import it.",
	"geo-blocked": "This video is not available in your region.",
	"rate-limited":
		"The site is limiting requests from your connection (HTTP 429). Wait a while and try again.",
	unavailable:
		"This video is unavailable (removed, deleted or it never existed).",
	"too-large": "The file is larger than the 2 GB limit.",
	network: "Could not reach the site. Check your internet connection.",
	unsupported:
		"This link is not a single video that can be imported (a channel, profile, playlist or other page).",
	"no-compatible-format":
		"This video has no single-file version the editor can play. Try Audio only, or another video.",
	timeout:
		"The download took too long or stopped responding, so it was stopped.",
	"bad-output": "yt-dlp did not produce one usable media file.",
	unknown:
		"yt-dlp could not import this link. Updating yt-dlp may help.",
	"bridge-failed":
		"The desktop app did not answer as expected. Restart Ccut and try again.",
	"storage-full": "There is not enough storage space in Ccut for this file.",
	"transfer-failed": "Copying the downloaded file into Ccut failed.",
	"import-failed":
		"The downloaded file could not be added to the project. The notification shows why.",
};

export function messageFor({ code }: { code: LinkImportErrorCode }): string {
	return LINK_IMPORT_MESSAGES[code] ?? LINK_IMPORT_MESSAGES.unknown;
}
