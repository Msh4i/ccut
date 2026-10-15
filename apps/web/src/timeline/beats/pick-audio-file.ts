/** Opens the system file dialog for one audio file; null when it is cancelled. */
export function pickAudioFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "audio/*,.wav,.mp3,.flac,.ogg,.m4a";
		input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
		input.addEventListener("cancel", () => resolve(null), { once: true });
		input.click();
	});
}
