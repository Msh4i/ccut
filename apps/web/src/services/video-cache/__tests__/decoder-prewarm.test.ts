import { expect, test } from "bun:test";
import { DecoderPrewarmer } from "../decoder-prewarm";

test("each asset is warmed once, one after the other, and isWarming follows", async () => {
	const order: string[] = [];
	let release: () => void = () => {};
	const prewarmer = new DecoderPrewarmer(async ({ file }) => {
		order.push(`start ${file.name}`);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		order.push(`end ${file.name}`);
	});
	const a = new File([], "a");
	const b = new File([], "b");
	const first = prewarmer.request({ assetId: "a", file: a });
	const again = prewarmer.request({ assetId: "a", file: a });
	const second = prewarmer.request({ assetId: "b", file: b });
	expect(again).toBe(first);
	expect(prewarmer.isWarming()).toBe(true);
	await Promise.resolve();
	release();
	await first;
	await Promise.resolve();
	release();
	await second;
	expect(order).toEqual(["start a", "end a", "start b", "end b"]);
	expect(prewarmer.isWarming()).toBe(false);
});

test("a failing warm-up does not reject and does not stay 'warming'", async () => {
	const prewarmer = new DecoderPrewarmer(async () => {
		throw new Error("gpu");
	});
	await prewarmer.request({ assetId: "x", file: new File([], "x") });
	expect(prewarmer.isWarming()).toBe(false);
});
