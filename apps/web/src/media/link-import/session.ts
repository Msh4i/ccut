import { sweepTempFiles, type TempFileStorage } from "./transfer";

// Per page session: the temporary files an imported asset still points at (kept), and one
// sweep of the files earlier sessions left behind (their assets now load from the project).

export const SESSION_TEMP_NAMES = new Set<string>();

let sweep: Promise<number> | null = null;

/** Sweeps once per page session; later calls get the first sweep's promise. */
export function sweepTempFilesOnce({
	storage,
}: {
	storage: TempFileStorage;
}): Promise<number> {
	sweep ??= sweepTempFiles({ storage, keep: SESSION_TEMP_NAMES });
	return sweep;
}
