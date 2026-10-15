import type { Matte, MatteSource } from "../matte/matte-registry";
import { activeKeyframe } from "./keyframes";
import { rasterizeStrokesLimited, rasterSize } from "./rasterize";
import type { ElementCutout } from "./types";

let revision = 0;

/** The matte of a clip's brush cutout: the active keyframe's strokes, rasterised once per keyframe. */
export class BrushMatteSource implements MatteSource {
	private readonly size: { width: number; height: number };
	private readonly cache = new Map<number, Matte>();
	private readonly id: string;

	constructor({ cutout, sourceWidth, sourceHeight, elementId }: { cutout: ElementCutout; sourceWidth: number; sourceHeight: number; elementId: string }) {
		this.cutout = cutout;
		this.size = rasterSize({ sourceWidth, sourceHeight });
		revision += 1;
		this.id = `brush:${elementId}:${revision}`;
	}

	readonly cutout: ElementCutout;

	lookup({ clipTime }: { sourceSeconds: number; clipTime: number }): Matte | null {
		const keyframe = activeKeyframe({ cutout: this.cutout, time: clipTime });
		if (!keyframe || keyframe.strokes.length === 0) return null;
		const cached = this.cache.get(keyframe.time);
		if (cached) return cached;
		const matte: Matte = {
			...this.size,
			data: rasterizeStrokesLimited({ strokes: keyframe.strokes, ...this.size }).data,
			hash: `${this.id}:${keyframe.time}`,
		};
		this.cache.set(keyframe.time, matte);
		return matte;
	}
}
