/**
 * Draw order of 3D layers (AE classic 3D): layers are drawn bottom to top in
 * track order, and each maximal run of CONSECUTIVE 3D layers is drawn back
 * to front by the camera-space depth of the layer centre (far first). A 2D
 * layer keeps its place and splits the runs: no 3D layer is moved across it.
 * Equal depths keep their track order.
 *
 * `depth: null` marks a 2D layer. Returns a new array.
 */
export function orderLayersForDepth<T extends { depth: number | null }>(
	entries: readonly T[],
): T[] {
	const ordered: T[] = [];
	let run: T[] = [];
	const flush = () => {
		if (run.length === 0) return;
		// Array.prototype.sort is stable: equal depths keep their order.
		run.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
		ordered.push(...run);
		run = [];
	};
	for (const entry of entries) {
		if (entry.depth === null) {
			flush();
			ordered.push(entry);
		} else {
			run.push(entry);
		}
	}
	flush();
	return ordered;
}
