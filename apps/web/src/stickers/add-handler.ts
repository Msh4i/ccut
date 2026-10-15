import type { SingleFlight } from "./single-flight";

/**
 * What a sticker tile does when its add button is pressed (or Enter): runs
 * `add` unless one is already running (a second press while a slow image loads
 * must not add a second element), shows the busy state for exactly that run,
 * and hands a failure to `onError`. The busy state is released whatever
 * happens, including when reporting the error itself fails.
 */
export function createAddHandler({
	flight,
	add,
	onError,
	onBusyChange,
}: {
	flight: SingleFlight;
	add: () => Promise<void>;
	onError: ({ error }: { error: unknown }) => void;
	onBusyChange: ({ busy }: { busy: boolean }) => void;
}): () => Promise<void> {
	return async () => {
		if (flight.isRunning()) {
			return;
		}

		onBusyChange({ busy: true });
		try {
			await flight.run(add);
		} catch (error) {
			try {
				onError({ error });
			} catch (reportError) {
				console.error("Could not report a failed add:", reportError);
			}
		} finally {
			onBusyChange({ busy: false });
		}
	};
}
