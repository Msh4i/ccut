import { describe, expect, mock, test } from "bun:test";
import { StorageQuotaExceededError } from "@/services/storage/quota";
import {
	SAVE_FAILURE_TOAST_ID,
	createToastSaveReporter,
	describeSaveFailure,
	getSaveRetryDelayMs,
} from "../save-failure";

const TITLE =
	"Couldn't save your project. Your latest changes are not saved yet.";
const QUOTA_HINT =
	"Not enough browser storage: free some space or remove unused media.";

describe("getSaveRetryDelayMs", () => {
	test("backs off 2 s, 5 s, 15 s and then settles on 30 s", () => {
		const delays = [1, 2, 3, 4, 5, 40].map((failureCount) =>
			getSaveRetryDelayMs({ failureCount }),
		);

		expect(delays).toEqual([2000, 5000, 15000, 30000, 30000, 30000]);
	});

	test("treats a zero, negative or non-numeric streak as the first failure", () => {
		expect(getSaveRetryDelayMs({ failureCount: 0 })).toBe(2000);
		expect(getSaveRetryDelayMs({ failureCount: -3 })).toBe(2000);
		expect(getSaveRetryDelayMs({ failureCount: Number.NaN })).toBe(2000);
	});
});

describe("describeSaveFailure", () => {
	test("tells the user what to do about a storage quota problem", () => {
		const quotaErrors = [
			new DOMException("The quota has been exceeded.", "QuotaExceededError"),
			new StorageQuotaExceededError({ requiredBytes: 1024 }),
			Object.assign(new Error("full"), { name: "NS_ERROR_DOM_QUOTA_REACHED" }),
		];

		for (const error of quotaErrors) {
			expect(describeSaveFailure({ error })).toEqual({
				title: TITLE,
				description: QUOTA_HINT,
			});
		}
	});

	test("gives other failures the same title and a retry hint instead of raw error text", () => {
		const errors: unknown[] = [
			new Error("disk on fire"),
			new DOMException("aborted", "AbortError"),
			"a string",
			null,
			undefined,
		];

		for (const error of errors) {
			const { title, description } = describeSaveFailure({ error });

			expect(title).toBe(TITLE);
			expect(description).not.toBe(QUOTA_HINT);
			expect(description).not.toContain("disk on fire");
			expect(description.length).toBeGreaterThan(0);
		}
	});
});

function createFakeToast() {
	return {
		error: mock((_message: string, _options?: object) => "id"),
		success: mock((_message: string, _options?: object) => "id"),
		dismiss: mock((_id?: string | number) => "id"),
	};
}

describe("createToastSaveReporter", () => {
	test("saveFailed shows one persistent error toast under the fixed id", () => {
		const toast = createFakeToast();
		const reporter = createToastSaveReporter({ toast });

		reporter.saveFailed({
			error: new DOMException("full", "QuotaExceededError"),
		});

		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith(TITLE, {
			id: SAVE_FAILURE_TOAST_ID,
			description: QUOTA_HINT,
			duration: Number.POSITIVE_INFINITY,
		});
	});

	test("saveRecovered dismisses the error toast and confirms briefly under another id", () => {
		const toast = createFakeToast();
		const reporter = createToastSaveReporter({ toast });

		reporter.saveRecovered();

		expect(toast.dismiss).toHaveBeenCalledWith(SAVE_FAILURE_TOAST_ID);
		expect(toast.success).toHaveBeenCalledTimes(1);
		const [message, options] = toast.success.mock.calls[0];
		expect(message).toBe("Project saved");
		expect(options).toMatchObject({ duration: expect.any(Number) });
		expect(options).not.toMatchObject({ id: SAVE_FAILURE_TOAST_ID });
	});

	test("dismissFailure removes the error toast without a success notice", () => {
		const toast = createFakeToast();
		const reporter = createToastSaveReporter({ toast });

		reporter.dismissFailure();

		expect(toast.dismiss).toHaveBeenCalledWith(SAVE_FAILURE_TOAST_ID);
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});
});
