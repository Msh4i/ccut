export type Easing = (progress: number) => number;

export const linear: Easing = (progress) => progress;

export const easeOutCubic: Easing = (progress) => 1 - (1 - progress) ** 3;

const BACK_OVERSHOOT = 1.70158;

/** Runs past 1 (peak about 1.10) and settles back to it. */
export const easeOutBack: Easing = (progress) => {
	const t = progress - 1;
	return 1 + (BACK_OVERSHOOT + 1) * t ** 3 + BACK_OVERSHOOT * t ** 2;
};
