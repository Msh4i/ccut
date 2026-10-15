// Hardware or software video decode? What the harness keeps of CDP SystemInfo.getInfo (the data of
// chrome://gpu, which the app window cannot open: main.js blocks foreign navigation and window.open)
// and of the CDP Media domain's player properties (the data of chrome://media-internals). Pure.

const DECODER_PROPERTY = /decoder/i;

/** The --enable-features of a command line; the last one wins, like Chromium's own parsing. */
function enabledFeaturesOf(commandLine) {
	if (typeof commandLine !== "string") return [];
	const values = [...commandLine.matchAll(/--enable-features=([^\s"]+)/g)].map((match) => match[1]);
	if (values.length === 0) return [];
	return values[values.length - 1]
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** SystemInfo.getInfo's answer -> the decode-related facts; null when there is no answer. */
function gpuDecodeStatus(info) {
	if (!info || typeof info !== "object") return null;
	const gpu = info.gpu && typeof info.gpu === "object" ? info.gpu : {};
	const status = gpu.featureStatus && typeof gpu.featureStatus === "object" ? gpu.featureStatus : {};
	const aux = gpu.auxAttributes && typeof gpu.auxAttributes === "object" ? gpu.auxAttributes : {};
	return {
		videoDecode: status.video_decode ?? null,
		webgpu: status.webgpu ?? null,
		gpuCompositing: status.gpu_compositing ?? null,
		decodeProfiles: Array.isArray(gpu.videoDecoding) ? gpu.videoDecoding.map((entry) => entry && entry.profile).filter((profile) => typeof profile === "string") : [],
		devices: Array.isArray(gpu.devices)
			? gpu.devices.filter(Boolean).map((device) => ({ vendor: device.vendorString ?? null, device: device.deviceString ?? null, driverVendor: device.driverVendor ?? null, driverVersion: device.driverVersion ?? null }))
			: [],
		glRenderer: typeof aux.glRenderer === "string" ? aux.glRenderer : null,
		displayType: typeof aux.displayType === "string" ? aux.displayType : null,
		enableFeatures: enabledFeaturesOf(info.commandLine),
	};
}

function unquote(value) {
	if (typeof value !== "string" || !value.startsWith('"') || !value.endsWith('"')) return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/**
 * CDP Media.playerPropertiesChanged events -> per player the properties whose name mentions a
 * decoder (e.g. kVideoDecoderName, kIsPlatformVideoDecoder), the last value of each; at most
 * `limit` players.
 */
function decoderReports({ events, limit = 16 }) {
	const players = new Map();
	for (const event of events) {
		if (!event || typeof event.playerId !== "string" || !Array.isArray(event.properties)) continue;
		for (const property of event.properties) {
			if (!property || typeof property.name !== "string" || !DECODER_PROPERTY.test(property.name)) continue;
			if (!players.has(event.playerId)) {
				if (players.size >= limit) continue;
				players.set(event.playerId, {});
			}
			players.get(event.playerId)[property.name] = unquote(property.value);
		}
	}
	return [...players.entries()].map(([playerId, properties]) => ({ playerId, properties }));
}

module.exports = { decoderReports, enabledFeaturesOf, gpuDecodeStatus };
