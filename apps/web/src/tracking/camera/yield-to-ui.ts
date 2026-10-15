/**
 * Hands the main thread back to the page for one task, so it can paint and
 * take input between two frames of an analysis that runs on it. A
 * MessageChannel task, chosen by measurement in Electron 44 on a 10 s 1080p30
 * clip (Plans/assets/camera-t2-spike.md): the page kept 60 frames a second and
 * the analysis took 3.7-3.8 s. `scheduler.yield()` continuations outrank
 * rendering (9-15 frames a second, a paint only every ~117 ms); a zero timeout
 * is clamped to 4 ms once nested (5.1-5.2 s). The channel is closed after its
 * one message, so no open port outlives the yield.
 */
export function yieldToUi(): Promise<void> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			resolve();
		};
		channel.port2.postMessage(null);
	});
}
