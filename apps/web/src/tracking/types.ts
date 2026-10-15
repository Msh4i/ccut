/** 8-bit luma of a decoded frame, row-major, `data.length === w * h`. */
export interface GrayFrame {
	w: number;
	h: number;
	data: Uint8Array;
}
