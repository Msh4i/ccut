/**
 * The decode worker as a whole stopped being usable (it crashed, its channel
 * broke, it did not answer in time, it could not open the file). Different from
 * the ordinary error of one call (a frame that could not be decoded or drawn),
 * which the stream handles as it does for a main-thread decoder: only a
 * `WorkerFailure` sends a stream back to the main thread
 * (`fallback-source.ts`) and never counts as an allocation failure.
 */
export class WorkerFailure extends Error {
	constructor({ message, cause }: { message: string; cause?: unknown }) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WorkerFailure";
	}
}

export function isWorkerFailure(error: unknown): error is WorkerFailure {
	return error instanceof WorkerFailure;
}
