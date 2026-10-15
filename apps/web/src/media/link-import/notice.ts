// The one-time notice "Only download content you have the right to use": once acknowledged,
// it is remembered in localStorage under its own key. A storage that throws (disabled, full)
// means "not acknowledged": the notice is shown again, nothing breaks.

export const NOTICE_STORAGE_KEY = "ccut-link-import-notice-acknowledged";
const ACKNOWLEDGED = "1";

interface NoticeStorage {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
}

export function hasAcknowledgedNotice({
	storage,
}: {
	storage: NoticeStorage | null;
}): boolean {
	try {
		return storage?.getItem(NOTICE_STORAGE_KEY) === ACKNOWLEDGED;
	} catch {
		return false;
	}
}

export function acknowledgeNotice({
	storage,
}: {
	storage: NoticeStorage | null;
}): void {
	try {
		storage?.setItem(NOTICE_STORAGE_KEY, ACKNOWLEDGED);
	} catch {
		// Shown again next time; the import itself goes on.
	}
}
