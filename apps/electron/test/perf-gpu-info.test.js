const { describe, expect, test } = require("bun:test");
const { decoderReports, enabledFeaturesOf, gpuDecodeStatus } = require("./perf/gpu-info");

// What the harness keeps of CDP SystemInfo.getInfo (the data chrome://gpu shows) and of the Media
// domain's player properties (what chrome://media-internals shows), to tell hardware from software decode.

// Shape of SystemInfo.getInfo's answer (CDP tip-of-tree docs); values made up for an Intel iGPU.
const INFO = {
	gpu: {
		devices: [{ vendorId: 32902, deviceId: 18086, vendorString: "Intel", deviceString: "Iris Xe", driverVendor: "Mesa", driverVersion: "25.2.1", subSysId: 0, revision: 0 }],
		auxAttributes: { glRenderer: "Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2)", displayType: "WAYLAND" },
		featureStatus: { video_decode: "enabled", video_encode: "disabled_software", webgpu: "enabled", gpu_compositing: "enabled", vulkan: "disabled_off" },
		driverBugWorkarounds: ["a", "b"],
		videoDecoding: [
			{ profile: "h264 baseline", maxResolution: { width: 4096, height: 4096 }, minResolution: { width: 16, height: 16 } },
			{ profile: "h264 high", maxResolution: { width: 4096, height: 4096 }, minResolution: { width: 16, height: 16 } },
		],
		videoEncoding: [],
	},
	modelName: "",
	modelVersion: "",
	commandLine: "/x/electron --type=browser --enable-features=Vulkan,AcceleratedVideoDecoder,AcceleratedVideoDecodeLinuxGL --remote-debugging-port=9222 --user-data-dir=/tmp/ccut-perf-ud-x",
};

describe("gpuDecodeStatus", () => {
	test("video decode status, WebGPU status, decode profiles, the GPU and the --enable-features the browser runs with", () => {
		expect(gpuDecodeStatus(INFO)).toEqual({
			videoDecode: "enabled",
			webgpu: "enabled",
			gpuCompositing: "enabled",
			decodeProfiles: ["h264 baseline", "h264 high"],
			devices: [{ vendor: "Intel", device: "Iris Xe", driverVendor: "Mesa", driverVersion: "25.2.1" }],
			glRenderer: "Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2)",
			displayType: "WAYLAND",
			enableFeatures: ["Vulkan", "AcceleratedVideoDecoder", "AcceleratedVideoDecodeLinuxGL"],
		});
	});

	test("missing parts are null or empty, not an error", () => {
		expect(gpuDecodeStatus({})).toEqual({ videoDecode: null, webgpu: null, gpuCompositing: null, decodeProfiles: [], devices: [], glRenderer: null, displayType: null, enableFeatures: [] });
		expect(gpuDecodeStatus(null)).toBeNull();
		expect(gpuDecodeStatus({ gpu: { videoDecoding: [null, { profile: 7 }, { profile: "vp9 profile0" }] } }).decodeProfiles).toEqual(["vp9 profile0"]);
	});
});

describe("enabledFeaturesOf", () => {
	test("the last --enable-features of a command line wins (Chromium's rule), quoted or not", () => {
		expect(enabledFeaturesOf("x --enable-features=A,B --y --enable-features=C")).toEqual(["C"]);
		expect(enabledFeaturesOf('x "--enable-features=A,B" y')).toEqual(["A", "B"]);
		expect(enabledFeaturesOf("x --disable-features=A")).toEqual([]);
		expect(enabledFeaturesOf(undefined)).toEqual([]);
	});
});

describe("decoderReports (CDP Media.playerPropertiesChanged)", () => {
	test("per player: the decoder properties only, last value wins, JSON-quoted values unquoted", () => {
		const events = [
			{ playerId: "p1", properties: [{ name: "kFrameUrl", value: "ccut://app/editor/1" }, { name: "kVideoDecoderName", value: '"FFmpegVideoDecoder"' }] },
			{ playerId: "p1", properties: [{ name: "kIsPlatformVideoDecoder", value: "false" }] },
			{ playerId: "p2", properties: [{ name: "kVideoDecoderName", value: '"VaapiVideoDecoder"' }, { name: "kIsPlatformVideoDecoder", value: "true" }] },
			{ playerId: "p3", properties: [{ name: "kTotalBytes", value: "5" }] },
			{ playerId: "p2", properties: [{ name: "kVideoDecoderName", value: '"MojoVideoDecoder"' }] },
		];
		expect(decoderReports({ events })).toEqual([
			{ playerId: "p1", properties: { kVideoDecoderName: "FFmpegVideoDecoder", kIsPlatformVideoDecoder: "false" } },
			{ playerId: "p2", properties: { kVideoDecoderName: "MojoVideoDecoder", kIsPlatformVideoDecoder: "true" } },
		]);
	});

	test("capped, and junk events are skipped", () => {
		const events = [null, { playerId: 5 }, { playerId: "x", properties: "no" }, ...Array.from({ length: 40 }, (_, i) => ({ playerId: `p${i}`, properties: [{ name: "kVideoDecoderName", value: "D" }] }))];
		expect(decoderReports({ events, limit: 16 })).toHaveLength(16);
	});
});
