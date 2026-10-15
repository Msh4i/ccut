/**
 * Camera paths of the synthetic footage: pan, zoom, roll, hand shake and their
 * mixes, as poses that say exactly where the camera was on every frame.
 */

/**
 * Camera pose: the world point `(wcx, wcy) + R(-theta) (p - frameCentre - d) / s`
 * shows at frame pixel `p`. So the picture is the world scaled by `s`, rotated
 * by `theta` (radians) and moved by `(dx, dy)` about the frame centre.
 */
export interface Pose {
	s: number;
	theta: number;
	dx: number;
	dy: number;
	wcx: number;
	wcy: number;
}

export interface Jitter {
	x: ((t: number) => number)[];
	y: ((t: number) => number)[];
	th: (t: number) => number;
	s: (t: number) => number;
}

/** Hand shake: three sinusoids per axis plus a little roll and zoom wobble. */
export function jitterPaths({ random }: { random: () => number }): Jitter {
	const make = ({ amp, freq }: { amp: number; freq: number }) => {
		const ph = random() * 6.28;
		const ph2 = random() * 6.28;
		return (t: number) =>
			amp *
			(0.7 * Math.sin((2 * Math.PI * freq * t) / 30 + ph) +
				0.3 * Math.sin((2 * Math.PI * freq * 2.3 * t) / 30 + ph2));
	};
	return {
		x: [make({ amp: 3, freq: 1.1 }), make({ amp: 2, freq: 2.7 }), make({ amp: 1.2, freq: 5.3 })],
		y: [make({ amp: 2.5, freq: 1.3 }), make({ amp: 1.8, freq: 3.1 }), make({ amp: 1, freq: 6.1 })],
		th: make({ amp: (0.3 * Math.PI) / 180, freq: 1.7 }),
		s: make({ amp: 0.003, freq: 0.9 }),
	};
}

export type PoseKind =
	| "static"
	| "pan"
	| "fastpan"
	| "zoom"
	| "zoomout"
	| "rot"
	| "hand"
	| "long"
	| "combo";

export interface PoseExtra {
	/** `fastpan`: px per frame. */
	speed?: number;
	/** `zoom`, `zoomout`: total factor. */
	zoom?: number;
	/** `rot`: peak angle in degrees. */
	deg?: number;
	/** World point at the frame centre when the camera is at rest. */
	wcx?: number;
	wcy?: number;
}

export function poseAt({
	kind,
	t,
	frameCount,
	jitter,
	extra,
}: {
	kind: PoseKind;
	t: number;
	frameCount: number;
	jitter: Jitter;
	extra: PoseExtra;
}): Pose {
	const pose: Pose = {
		s: 1,
		theta: 0,
		dx: 0,
		dy: 0,
		wcx: extra.wcx ?? 1000,
		wcy: extra.wcy ?? 900,
	};
	const u = frameCount > 1 ? t / (frameCount - 1) : 0;
	const shake = () => {
		let jx = 0;
		let jy = 0;
		for (const f of jitter.x) jx += f(t);
		for (const f of jitter.y) jy += f(t);
		pose.dx += jx;
		pose.dy += jy;
		pose.theta += jitter.th(t);
		pose.s *= 1 + jitter.s(t);
	};
	switch (kind) {
		case "static":
			break;
		case "pan":
			pose.dx = -2 * t;
			pose.dy = -0.4 * t;
			break;
		case "fastpan":
			pose.dx = -(extra.speed ?? 12) * t;
			break;
		case "zoom":
			pose.s = (extra.zoom ?? 1.5) ** u;
			pose.dx = -0.5 * t;
			break;
		case "zoomout":
			pose.s = (1 / (extra.zoom ?? 1.5)) ** u;
			break;
		case "rot":
			pose.theta = (((extra.deg ?? 10) * Math.PI) / 180) * Math.sin(2 * Math.PI * u);
			break;
		case "hand":
			pose.dx = -0.5 * t;
			shake();
			break;
		case "long":
			pose.dx = -0.5 * t;
			pose.dy = 60 * Math.sin(2 * Math.PI * u * 2);
			pose.s = 1.25 ** Math.sin(2 * Math.PI * u * 1.5);
			pose.theta = ((5 * Math.PI) / 180) * Math.sin(2 * Math.PI * u * 2.5);
			shake();
			break;
		case "combo":
			pose.dx = -1.5 * t;
			pose.dy = -0.3 * t;
			pose.s = 1.3 ** u;
			pose.theta = ((6 * Math.PI) / 180) * Math.sin(2 * Math.PI * u * 1.3);
			shake();
			break;
	}
	return pose;
}
