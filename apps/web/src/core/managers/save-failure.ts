import { toast } from "sonner";
import { isStorageQuotaExceededError } from "@/services/storage/quota";

/** One toast for a whole streak of failed saves: later failures reuse the id. */
export const SAVE_FAILURE_TOAST_ID = "project-save-failed";
const SAVE_RECOVERED_TOAST_ID = "project-save-recovered";
const SAVE_RECOVERED_TOAST_MS = 3_000;

const SAVE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;
const SAVE_RETRY_STEADY_DELAY_MS = 30_000;

const FAILURE_TITLE =
	"Couldn't save your project. Your latest changes are not saved yet.";
const QUOTA_DESCRIPTION =
	"Not enough browser storage: free some space or remove unused media.";
const GENERIC_DESCRIPTION =
	"We'll keep trying. Keep this window open until it is saved.";

/** How long to wait before retrying after `failureCount` failed saves in a row. */
export function getSaveRetryDelayMs({
	failureCount,
}: {
	failureCount: number;
}): number {
	const streak = Number.isFinite(failureCount)
		? Math.max(1, Math.floor(failureCount))
		: 1;
	return SAVE_RETRY_DELAYS_MS[streak - 1] ?? SAVE_RETRY_STEADY_DELAY_MS;
}

export function describeSaveFailure({ error }: { error: unknown }): {
	title: string;
	description: string;
} {
	return {
		title: FAILURE_TITLE,
		description: isStorageQuotaExceededError({ error })
			? QUOTA_DESCRIPTION
			: GENERIC_DESCRIPTION,
	};
}

export type SaveReporter = {
	/** The first failed save of a streak. */
	saveFailed(args: { error: unknown }): void;
	/** A save worked after a streak of failures. */
	saveRecovered(): void;
	/** The unsaved state was dropped on purpose (project closed or deleted). */
	dismissFailure(): void;
};

type ToastApi = {
	error(
		message: string,
		options?: { id?: string; description?: string; duration?: number },
	): unknown;
	success(
		message: string,
		options?: { id?: string; description?: string; duration?: number },
	): unknown;
	dismiss(id?: string | number): unknown;
};

export function createToastSaveReporter({
	toast: toastApi = toast,
}: {
	toast?: ToastApi;
} = {}): SaveReporter {
	return {
		saveFailed({ error }) {
			const { title, description } = describeSaveFailure({ error });
			toastApi.error(title, {
				id: SAVE_FAILURE_TOAST_ID,
				description,
				duration: Number.POSITIVE_INFINITY,
			});
		},
		saveRecovered() {
			toastApi.dismiss(SAVE_FAILURE_TOAST_ID);
			toastApi.success("Project saved", {
				id: SAVE_RECOVERED_TOAST_ID,
				duration: SAVE_RECOVERED_TOAST_MS,
			});
		},
		dismissFailure() {
			toastApi.dismiss(SAVE_FAILURE_TOAST_ID);
		},
	};
}
