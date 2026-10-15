/**
 * H.264 level selection (ITU-T H.264 Annex A, Table A-1) for High profile.
 *
 * A level fits a stream when (A.3.1 / A.3.3):
 *   - frame size in macroblocks <= MaxFS,
 *   - macroblocks per second <= MaxMBPS,
 *   - frame width and height in macroblocks <= sqrt(8 * MaxFS),
 *   - bitrate <= cpbBrVclFactor * MaxBR, with cpbBrVclFactor = 1250 for High
 *     (MaxBR is in units of 1000 bit/s for Baseline/Main: x1.25 for High).
 * The DPB limit (MaxDpbMbs) depends on the encoder's reference count and is
 * not checked here. Levels above 5.2 (8K) are out of scope (export-v2 P3).
 * Level 1b is left out (not needed at export sizes).
 */

export interface AvcLevel {
	name: string;
	/** level_idc (level x 10). */
	idc: number;
	maxMbps: number;
	maxFs: number;
	/** kbit/s, Baseline/Main units. */
	maxBr: number;
}

export const AVC_LEVELS: readonly AvcLevel[] = [
	{ name: "1", idc: 10, maxMbps: 1_485, maxFs: 99, maxBr: 64 },
	{ name: "1.1", idc: 11, maxMbps: 3_000, maxFs: 396, maxBr: 192 },
	{ name: "1.2", idc: 12, maxMbps: 6_000, maxFs: 396, maxBr: 384 },
	{ name: "1.3", idc: 13, maxMbps: 11_880, maxFs: 396, maxBr: 768 },
	{ name: "2", idc: 20, maxMbps: 11_880, maxFs: 396, maxBr: 2_000 },
	{ name: "2.1", idc: 21, maxMbps: 19_800, maxFs: 792, maxBr: 4_000 },
	{ name: "2.2", idc: 22, maxMbps: 20_250, maxFs: 1_620, maxBr: 4_000 },
	{ name: "3", idc: 30, maxMbps: 40_500, maxFs: 1_620, maxBr: 10_000 },
	{ name: "3.1", idc: 31, maxMbps: 108_000, maxFs: 3_600, maxBr: 14_000 },
	{ name: "3.2", idc: 32, maxMbps: 216_000, maxFs: 5_120, maxBr: 20_000 },
	{ name: "4", idc: 40, maxMbps: 245_760, maxFs: 8_192, maxBr: 20_000 },
	{ name: "4.1", idc: 41, maxMbps: 245_760, maxFs: 8_192, maxBr: 50_000 },
	{ name: "4.2", idc: 42, maxMbps: 522_240, maxFs: 8_704, maxBr: 50_000 },
	{ name: "5", idc: 50, maxMbps: 589_824, maxFs: 22_080, maxBr: 135_000 },
	{ name: "5.1", idc: 51, maxMbps: 983_040, maxFs: 36_864, maxBr: 240_000 },
	{ name: "5.2", idc: 52, maxMbps: 2_073_600, maxFs: 36_864, maxBr: 240_000 },
];

const HIGH_PROFILE_BR_FACTOR = 1250;
const HIGH_PROFILE_IDC = 0x64;

/** Highest bitrate (bit/s) a High-profile stream may have at `level`. */
export function avcHighMaxBitrate({ level }: { level: AvcLevel }): number {
	return level.maxBr * HIGH_PROFILE_BR_FACTOR;
}

/** Highest bitrate any supported level allows (level 5.2 High: 300 Mb/s). */
export const AVC_MAX_BITRATE = Math.max(...AVC_LEVELS.map((level) => avcHighMaxBitrate({ level })));

/** Lowest level that fits, or `null` when even 5.2 does not. */
export function pickAvcLevel({
	width,
	height,
	fps,
	bitrate,
}: {
	width: number;
	height: number;
	fps: number;
	bitrate: number;
}): AvcLevel | null {
	for (const [name, value] of [
		["width", width],
		["height", height],
		["fps", fps],
		["bitrate", bitrate],
	] as const) {
		if (!Number.isFinite(value) || value <= 0) {
			throw new RangeError(`${name} must be a positive number, got ${value}`);
		}
	}
	const widthMbs = Math.ceil(width / 16);
	const heightMbs = Math.ceil(height / 16);
	const frameMbs = widthMbs * heightMbs;
	const mbps = frameMbs * fps;

	for (const level of AVC_LEVELS) {
		const maxSide = Math.sqrt(8 * level.maxFs);
		if (
			frameMbs <= level.maxFs &&
			mbps <= level.maxMbps &&
			widthMbs <= maxSide &&
			heightMbs <= maxSide &&
			bitrate <= avcHighMaxBitrate({ level })
		) {
			return level;
		}
	}
	return null;
}

/** RFC 6381 codec string: `avc1.` + profile_idc, constraint flags, level_idc (hex). */
export function avcCodecString({ level }: { level: AvcLevel }): string {
	const hex = (value: number) => value.toString(16).padStart(2, "0");
	return `avc1.${hex(HIGH_PROFILE_IDC)}00${hex(level.idc)}`;
}
