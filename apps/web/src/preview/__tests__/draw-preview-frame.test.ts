import { describe, expect, test } from "bun:test";
import { drawPreviewFrame, shouldRenderPreview } from "../render-gate";

// The preview draws from an animation-frame loop and used to chain only a
// success handler onto the draw. A draw that rejected once (a broken image, a
// codec the browser cannot decode) left the "drawing" flag set for good, so the
// preview never drew again. The serial rule that now redraws after an export
// would also retry a failed draw on every animation frame, unless the failed
// attempt records a serial too.

const scene = {};
const otherScene = {};

describe("drawPreviewFrame", () => {
	test("a successful draw hands back the serial the draw returned and no error", async () => {
		const result = await drawPreviewFrame({
			draw: async () => 9,
			serialNow: () => 5,
		});
		expect(result).toEqual({ serial: 9, error: null, effectsDropped: false });
	});

	test("a rejecting draw never rejects: the error is captured and the serial is the compositor's current one", async () => {
		const failure = new Error("Image load failed");
		const result = await drawPreviewFrame({
			draw: async () => {
				throw failure;
			},
			serialNow: () => 5,
		});
		expect(result.error).toBe(failure);
		expect(result.serial).toBe(5);
	});

	test("the serial of a failed draw is read after the failure, not before the draw started", async () => {
		let serial = 5;
		const result = await drawPreviewFrame({
			draw: async () => {
				// something else (the exporter) drew while this draw was pending
				serial = 8;
				throw new Error("Decoder failed");
			},
			serialNow: () => serial,
		});
		expect(result.serial).toBe(8);
	});

	test("a draw that throws synchronously is handled like a rejected one", async () => {
		const failure = new Error("Sync failure");
		const result = await drawPreviewFrame({
			draw: () => {
				throw failure;
			},
			serialNow: () => 3,
		});
		expect(result.error).toBe(failure);
		expect(result.serial).toBe(3);
	});

	test("values that are not Error objects are captured as they were thrown", async () => {
		const thrown: unknown[] = ["decode failed", 42, { reason: "x" }, undefined];
		for (const value of thrown) {
			const result = await drawPreviewFrame({
				draw: () => Promise.reject(value),
				serialNow: () => 1,
			});
			expect(result.error).toBe(value);
			expect(result.serial).toBe(1);
		}
	});

	test("a draw rejected with null still reports an error, so it cannot pass for a success", async () => {
		const result = await drawPreviewFrame({
			draw: () => Promise.reject(null),
			serialNow: () => 1,
		});
		expect(result.error).not.toBeNull();
		expect(result.serial).toBe(1);
	});

	test("the success path leaves the serial source alone", async () => {
		let serialReads = 0;
		await drawPreviewFrame({
			draw: async () => 4,
			serialNow: () => {
				serialReads += 1;
				return 0;
			},
		});
		expect(serialReads).toBe(0);
	});
});

describe("a failed draw and the render gate", () => {
	test("is not retried on every animation frame, only when the frame or the scene changes", async () => {
		const compositorSerial = 7;
		const failed = await drawPreviewFrame({
			draw: async () => {
				throw new Error("Image load failed");
			},
			serialNow: () => compositorSerial,
		});

		const afterFailure = {
			isExporting: false,
			frame: 12,
			lastFrame: 12,
			scene,
			lastScene: scene,
			compositorSerial,
			lastOwnSerial: failed.serial,
			maxStaleSeconds: 0,
			lastMaxStaleSeconds: 0,
		};
		for (let animationFrame = 0; animationFrame < 60; animationFrame++) {
			expect(shouldRenderPreview(afterFailure)).toBe(false);
		}
		expect(shouldRenderPreview({ ...afterFailure, frame: 13 })).toBe(true);
		expect(shouldRenderPreview({ ...afterFailure, scene: otherScene })).toBe(true);
	});

	test("is retried once someone else drew into the compositor since (an export finished)", async () => {
		const failed = await drawPreviewFrame({
			draw: async () => {
				throw new Error("Image load failed");
			},
			serialNow: () => 7,
		});
		const afterExport = {
			isExporting: false,
			frame: 12,
			lastFrame: 12,
			scene,
			lastScene: scene,
			compositorSerial: 190,
			lastOwnSerial: failed.serial,
			maxStaleSeconds: 0,
			lastMaxStaleSeconds: 0,
		};
		expect(shouldRenderPreview(afterExport)).toBe(true);
	});

	test("a successful draw is not repeated either", async () => {
		const drawn = await drawPreviewFrame({
			draw: async () => 8,
			serialNow: () => 7,
		});
		expect(
			shouldRenderPreview({
				isExporting: false,
				frame: 12,
				lastFrame: 12,
				scene,
				lastScene: scene,
				compositorSerial: 8,
				lastOwnSerial: drawn.serial,
				maxStaleSeconds: 0,
				lastMaxStaleSeconds: 0,
			}),
		).toBe(false);
	});
});
