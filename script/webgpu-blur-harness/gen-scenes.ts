import { buildGaussianBlurPasses, intensityToSigma } from "../../apps/web/src/effects/definitions/blur.ts";
import { writeFileSync } from "node:fs";
const sizes: Array<[string, number, number]> = [["1920x1080",1920,1080],["1080x1920 (9:16)",1080,1920],["777x433 odd",777,433],["1x1",1,1],["3x5",3,5],["4096x2304",4096,2304],["4096x4096",4096,4096]];
const intens = [0, 1, 15, 50, 100, 250];
const scenes: unknown[] = [];
for (const [label, w, h] of sizes) for (const intensity of intens) {
	const passes = buildGaussianBlurPasses({ sigmaX: intensityToSigma({ intensity, resolution: w, reference: 1920 }), sigmaY: intensityToSigma({ intensity, resolution: h, reference: 1080 }) });
	scenes.push({ label, width: w, height: h, intensity, passCount: passes.length, groups: passes.length ? [passes] : [] });
}
writeFileSync(new URL("./scenes.json", import.meta.url), JSON.stringify(scenes));
console.log(scenes.length, "scenes");
