import { simplifySeries } from "@/tracking/simplify";
import type { CameraPinChannels, LocalRect } from "./to-channels";

/** How far (canvas px) the simplified channels may put the element's corners from the tracked ones. */
export const CAMERA_PIN_BUDGET = 0.5;

export interface PinKey {
	/** Timeline seconds. */
	time: number;
	value: number;
}

export interface SimplifiedPinChannels {
	x: PinKey[];
	y: PinKey[];
	scaleX: PinKey[];
	scaleY: PinKey[];
	rotate: PinKey[];
}

export interface PinTolerances {
	/** The element's half diagonal, canvas px, at its largest. */
	radius: number;
	/** Position tolerance of x and y each, canvas px. */
	position: number;
	/** Scale tolerance of scaleX and scaleY each, as a share of the value. */
	scale: number;
	/** Rotation tolerance, degrees. */
	rotationDeg: number;
}

/**
 * Shares the budget `B` out over the channels so that their errors add up to
 * at most `B` at the element's corners: x and y get `B / 3` each; a relative
 * scale error `e` or a rotation error of `e` radians moves a corner by up to
 * `R e`, so they get `B / (6 R)` each (`R` the element's half diagonal).
 * The radius is taken at the largest size the element reaches, so the corners
 * stay inside the budget when the camera zooms in.
 */
export function pinTolerances({
	channels,
	bounds,
	budget = CAMERA_PIN_BUDGET,
}: {
	channels: Pick<CameraPinChannels, "scaleX" | "scaleY">;
	bounds: LocalRect;
	budget?: number;
}): PinTolerances {
	let radius = 0;
	for (let i = 0; i < channels.scaleX.length; i++) {
		radius = Math.max(
			radius,
			0.5 * Math.hypot(bounds.width * channels.scaleX[i], bounds.height * channels.scaleY[i]),
		);
	}
	const share = budget / (6 * Math.max(radius, 1e-9));
	return {
		radius,
		position: budget / 3,
		scale: share,
		rotationDeg: (share * 180) / Math.PI,
	};
}

/**
 * One independent Ramer-Douglas-Peucker pass per channel, within the budget of
 * `pinTolerances`. A camera shake is hardly simplified (about as many keys as
 * samples), a pan or a zoom becomes a few dozen. Times are the samples' own.
 * The pin frame's sample is always a key (when `pinFrame` is given), the one
 * place where the element has to be exactly as the user left it.
 */
export function simplifyCameraPinChannels({
	channels,
	bounds,
	budget = CAMERA_PIN_BUDGET,
	pinFrame,
}: {
	channels: CameraPinChannels;
	bounds: LocalRect;
	budget?: number;
	/** The analysis frame whose sample is always a key, so the element looks exactly as it was there. */
	pinFrame?: number;
}): SimplifiedPinChannels {
	const tolerance = pinTolerances({ channels, bounds, budget });
	const pinned = pinFrame === undefined ? undefined : [channels.frames.indexOf(pinFrame)];
	const keysOf = ({
		values,
		epsilon,
		relative,
	}: {
		values: Float64Array;
		epsilon: number;
		relative?: boolean;
	}): PinKey[] =>
		simplifySeries({ times: channels.times, values, epsilon, relative, pinned }).map((i) => ({
			time: channels.times[i],
			value: values[i],
		}));
	return {
		x: keysOf({ values: channels.x, epsilon: tolerance.position }),
		y: keysOf({ values: channels.y, epsilon: tolerance.position }),
		scaleX: keysOf({ values: channels.scaleX, epsilon: tolerance.scale, relative: true }),
		scaleY: keysOf({ values: channels.scaleY, epsilon: tolerance.scale, relative: true }),
		rotate: keysOf({ values: channels.rotate, epsilon: tolerance.rotationDeg }),
	};
}
