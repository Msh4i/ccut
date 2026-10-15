import { MAX_TOTAL_MATTE_BYTES } from "./constants";

/**
 * Which clips' mattes are in memory and how many bytes they take. Adding one beyond the cap
 * evicts the least recently added others (their data stays on disk; a later restore brings it back).
 */
export class MatteLedger {
	private readonly bytesByClip = new Map<string, number>();

	constructor(private readonly maxBytes: number = MAX_TOTAL_MATTE_BYTES) {}

	/** Records `bytes` for the clip; returns the clips that must be dropped from memory. */
	admit({ clipId, bytes }: { clipId: string; bytes: number }): string[] {
		this.bytesByClip.delete(clipId);
		this.bytesByClip.set(clipId, bytes);
		const evicted: string[] = [];
		let total = [...this.bytesByClip.values()].reduce((sum, value) => sum + value, 0);
		for (const [other, size] of this.bytesByClip) {
			if (total <= this.maxBytes) break;
			if (other === clipId) continue;
			this.bytesByClip.delete(other);
			evicted.push(other);
			total -= size;
		}
		return evicted;
	}

	release({ clipId }: { clipId: string }): void {
		this.bytesByClip.delete(clipId);
	}

	get totalBytes(): number {
		return [...this.bytesByClip.values()].reduce((sum, value) => sum + value, 0);
	}
}
