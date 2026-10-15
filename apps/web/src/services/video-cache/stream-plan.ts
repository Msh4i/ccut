import { DECODER_QUEUE_FRAMES, READ_AHEAD_MIN_FRAMES } from "./frame-policy";
import { needsLargerDraw } from "./frame-scale";

/**
 * Which decoder stream a frame request goes to, when clips of one file
 * outnumber the streams it may have: pure decisions of the video cache
 * (`service.ts` keeps the streams and applies them).
 *
 * Every request carries its clip's key (the timeline element id). A stream
 * belongs to one clip, its owner. A clip uses its own stream; a new clip
 * takes over an idle stream its time continues (a split clip) or one whose
 * owner left the screen, else opens one while the media is below its quota,
 * else BORROWS a stream: its request queues behind the owner's on that
 * stream and the owner stays. A request never overtakes or replaces another
 * clip's request, so a clip is never answered with another clip's picture:
 * with more clips than streams it gets its own frame later (the borrowed
 * decoder restarts) instead of a wrong one at once.
 *
 * A stream with a request in flight is never taken over or evicted.
 */

/** What the plan needs to know about one stream of the media. */
export type SlotView = {
	/** The clip the stream belongs to; null: only requests without a key used it. */
	owner: string | null;
	/** Activity time (ms) its owner last asked for a frame; a borrower does not move it. */
	ownerAskedAt: number;
	/**
	 * Media time of its newest request of ANY key (a borrower's included):
	 * where its decoder will be once its queue ran. NaN: none.
	 */
	position: number;
	/**
	 * Media time of its owner's newest request (NaN: none). A split clip
	 * continues its OWNER, not a borrower: a borrower whose own last request
	 * is the stream's newest must not look like a continuation of it.
	 */
	ownerPosition: number;
	/** Timestamp of the frame on its canvas; null: none. */
	shownTimestamp: number | null;
	/** Requests queued and not finished. */
	pending: number;
	/**
	 * Time of the newest request of each key on this stream that a request of
	 * the same key and time may share (still queued, or its answer still the
	 * frame on the canvas). The plan matches times only: the cache (C3) lists
	 * only such requests and re-checks the scale and that the answer's canvas
	 * is not retired or recycled before sharing it.
	 */
	latest: ReadonlyMap<string | null, number>;
};

export type StreamPickLimits = {
	/**
	 * A new clip takes over an idle stream another clip still owns when its
	 * time continues that stream forward by at most this (s): a split clip
	 * plays on across its cut. Also the borrow preference. The decoder's
	 * `alwaysAdvanceSeconds`.
	 */
	continueSeconds: number;
	/**
	 * A stream whose owner left, or a request without a key, continues a
	 * stream within this (s): the decoder's forward window
	 * (`maxAdvanceSeconds`).
	 */
	maxAdvanceSeconds: number;
	/** An owner not asked for during this much activity (ms) has left the screen. */
	reuseIdleAfterMs: number;
};

/**
 * own: the clip's stream. join: the stream that already has a request of
 * this key (no key: of any key) for this time; one answer serves both.
 * take: an idle stream changes owner to this clip. open: a new stream owned
 * by this clip. borrow: queue on another clip's stream, its owner stays.
 */
export type StreamPick =
	| { kind: "own"; index: number }
	| { kind: "join"; index: number }
	| { kind: "take"; index: number }
	| { kind: "open" }
	| { kind: "borrow"; index: number };

/** Whether `time` goes on from the stream within `seconds`: not before its frame, at most that far past its newest request. */
function continues({
	slot,
	time,
	seconds,
}: {
	slot: SlotView;
	time: number;
	seconds: number;
}): boolean {
	const from =
		slot.shownTimestamp === null ? slot.position : Math.min(slot.shownTimestamp, slot.position);
	return time >= from && time - slot.position <= seconds;
}

/** Index of the nearest stream `accept` lets through that `time` continues within `seconds`; -1: none. */
function nearestContinued({
	slots,
	time,
	seconds,
	accept,
}: {
	slots: SlotView[];
	time: number;
	seconds: number;
	accept: (slot: SlotView) => boolean;
}): number {
	let best = -1;
	for (let index = 0; index < slots.length; index++) {
		const slot = slots[index];
		if (!accept(slot) || !continues({ slot, time, seconds })) continue;
		if (best < 0 || Math.abs(time - slot.position) < Math.abs(time - slots[best].position)) {
			best = index;
		}
	}
	return best;
}

/**
 * Index of the nearest stream `accept` lets through whose OWNER's newest
 * request `time` continues forward by at most `seconds` (a split clip); -1:
 * none.
 */
function nearestSplit({
	slots,
	time,
	seconds,
	accept,
}: {
	slots: SlotView[];
	time: number;
	seconds: number;
	accept: (slot: SlotView) => boolean;
}): number {
	let best = -1;
	for (let index = 0; index < slots.length; index++) {
		const slot = slots[index];
		const ahead = time - slot.ownerPosition;
		if (!accept(slot) || !(ahead >= 0 && ahead <= seconds)) continue;
		if (best < 0 || ahead < time - slots[best].ownerPosition) best = index;
	}
	return best;
}

/**
 * The stream a borrower queues on: the fewest requests in flight (it waits
 * least); then one its time continues forward by at most `continueSeconds`
 * (its decoder goes on instead of restarting); then the least recently asked
 * owner; then the lowest index. Null without streams.
 */
export function chooseBorrowSlot({
	time,
	slots,
	continueSeconds,
}: {
	time: number;
	slots: SlotView[];
	continueSeconds: number;
}): number | null {
	let best: number | null = null;
	let bestRank: [number, number, number] = [0, 0, 0];
	for (let index = 0; index < slots.length; index++) {
		const slot = slots[index];
		const forward = time >= slot.position && time - slot.position <= continueSeconds;
		const rank: [number, number, number] = [slot.pending, forward ? 0 : 1, slot.ownerAskedAt];
		if (best === null || isBefore({ rank, than: bestRank })) {
			best = index;
			bestRank = rank;
		}
	}
	return best;
}

function isBefore({
	rank,
	than,
}: {
	rank: [number, number, number];
	than: [number, number, number];
}): boolean {
	for (let index = 0; index < rank.length; index++) {
		if (rank[index] !== than[index]) return rank[index] < than[index];
	}
	return false;
}

/**
 * Where a request for `time` of clip `key` (null: a request without a key)
 * goes among the media's `slots`. `quota`: the streams the media may have
 * (`streamQuota`); `activityMs`: the cache's activity clock.
 *
 * With a key: its own stream; else its own request for the same time
 * (`join`); else an IDLE stream whose owner's newest time it continues by
 * `continueSeconds` (a split clip), or whose owner left (one the time continues within the decoder's window
 * first, then the least recently asked); else a new stream below the quota
 * (or when the media has none); else `borrow` (`chooseBorrowSlot`).
 * Without a key: any request for the same time; else the nearest stream the
 * time continues within the decoder's window, idle first (scrubbing one
 * clip); else open or borrow as above.
 */
export function planStreamPick({
	key,
	time,
	slots,
	quota,
	limits,
	activityMs,
}: {
	key: string | null;
	time: number;
	slots: SlotView[];
	quota: number;
	limits: StreamPickLimits;
	activityMs: number;
}): StreamPick {
	if (key !== null) {
		const own = slots.findIndex((slot) => slot.owner === key);
		if (own >= 0) return { kind: "own", index: own };
		const joined = slots.findIndex((slot) => slot.latest.get(key) === time);
		if (joined >= 0) return { kind: "join", index: joined };

		const idle = (slot: SlotView) => slot.pending === 0;
		const left = (slot: SlotView) =>
			idle(slot) && activityMs - slot.ownerAskedAt >= limits.reuseIdleAfterMs;
		const split = nearestSplit({ slots, time, seconds: limits.continueSeconds, accept: idle });
		if (split >= 0) return { kind: "take", index: split };
		const continued = nearestContinued({
			slots,
			time,
			seconds: limits.maxAdvanceSeconds,
			accept: left,
		});
		if (continued >= 0) return { kind: "take", index: continued };
		let oldest = -1;
		for (let index = 0; index < slots.length; index++) {
			if (!left(slots[index])) continue;
			if (oldest < 0 || slots[index].ownerAskedAt < slots[oldest].ownerAskedAt) oldest = index;
		}
		if (oldest >= 0) return { kind: "take", index: oldest };
	} else {
		const joined = slots.findIndex((slot) => [...slot.latest.values()].includes(time));
		if (joined >= 0) return { kind: "join", index: joined };
		for (const accept of [(slot: SlotView) => slot.pending === 0, () => true]) {
			const near = nearestContinued({ slots, time, seconds: limits.maxAdvanceSeconds, accept });
			if (near >= 0) return { kind: "borrow", index: near };
		}
	}

	if (slots.length === 0 || slots.length < quota) return { kind: "open" };
	const borrowed = chooseBorrowSlot({ time, slots, continueSeconds: limits.continueSeconds });
	return borrowed === null ? { kind: "open" } : { kind: "borrow", index: borrowed };
}

/** A count read as whole clips: anything not above 0 is none, a fraction of one is one. */
function wholeCount(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.max(1, Math.floor(value));
}

/**
 * Streams each media may have, from the clips of it on screen
 * (`clipsByMedia`, scene order): one per clip up to `maxPerMedia`, at least
 * one per visible media, and over every media at most `maxTotal`, shared out
 * one by one in scene order. Soft: more visible media than `maxTotal` still
 * get one each. A media with no visible clip gets 0.
 */
export function streamQuota({
	clipsByMedia,
	limits,
}: {
	clipsByMedia: ReadonlyMap<string, number>;
	limits: { maxPerMedia: number; maxTotal: number };
}): Map<string, number> {
	// NaN: one per media; Infinity: no bound per media.
	const perMedia = Number.isNaN(limits.maxPerMedia) ? 1 : Math.max(1, Math.floor(limits.maxPerMedia));
	const wanted = new Map<string, number>();
	const quota = new Map<string, number>();
	let given = 0;
	let mostWanted = 0;
	for (const [mediaId, clips] of clipsByMedia) {
		const want = Math.min(perMedia, wholeCount(clips));
		wanted.set(mediaId, want);
		quota.set(mediaId, Math.min(1, want));
		given += Math.min(1, want);
		mostWanted = Math.max(mostWanted, want);
	}
	const total = Number.isNaN(limits.maxTotal) ? 0 : Math.floor(limits.maxTotal);
	let left = total - given;
	// Round r gives a stream number r + 1 to every media that wants that many.
	for (let round = 1; left > 0 && round < mostWanted; round++) {
		for (const [mediaId, want] of wanted) {
			if (left <= 0 || round >= want) continue;
			quota.set(mediaId, round + 1);
			left -= 1;
		}
	}
	return quota;
}

/** Decoded frame a stream keeps to redraw its shown frame larger without a restart. */
export const KEPT_DECODED_FRAMES = 1;

/**
 * Decoded frames one stream holds at least while it plays: the minimum
 * read-ahead, mediabunny's queue and the kept frame. OWNER DECISION: the
 * stream cap below reserves this many per stream out of the whole budget.
 */
export const STREAM_DECODED_FRAMES =
	READ_AHEAD_MIN_FRAMES + DECODER_QUEUE_FRAMES + KEPT_DECODED_FRAMES;

/** The canvas a stream shows, counted at full size (a paused preview or an export draws at scale 1). */
export const STREAM_SHOWN_CANVASES = 1;

/**
 * Streams per media the memory budget allows: the budget shared by the
 * visible media, less the free canvases the media needs (`mediaCanvases` at
 * the scale drawn), over what one stream holds: its decoded frames (the
 * decoder's queue and the minimum read-ahead, plus the kept frame when frames
 * are kept: `STREAM_DECODED_FRAMES`) and its shown canvas at the scale drawn.
 * Between 1 and `maxPerMedia`. 1080p at full size: 4 at 256 MB (up to `maxPerMedia` with a bigger budget), 1
 * at the 64 MB floor; 4K at 256 MB: 1; 1080p at 1/4 at the floor without kept
 * frames: 2. The drawn-frame cache's budget must leave room for these
 * streams. Anything invalid gives 1.
 */
export function streamCapForBudget({
	budgetBytes,
	decodedFrameBytes,
	drawnFrameBytes,
	visibleMedia,
	maxPerMedia,
	shownScale = 1,
	keepsDecoded = true,
	mediaCanvases = 0,
}: {
	budgetBytes: number;
	decodedFrameBytes: number;
	/** One frame drawn at scale 1 (RGBA, display size). */
	drawnFrameBytes: number;
	visibleMedia: number;
	maxPerMedia: number;
	/** The scale the media's frames are drawn at (default 1: full size). */
	shownScale?: number;
	/** Streams keep the decoded frame of a small shown frame (not under memory pressure). */
	keepsDecoded?: boolean;
	/** Canvases the media keeps besides the shown ones (its free list for a render's draws). */
	mediaCanvases?: number;
}): number {
	if (
		!(budgetBytes > 0) ||
		!(decodedFrameBytes > 0) ||
		!(drawnFrameBytes > 0) ||
		!(maxPerMedia >= 1)
	) {
		return 1;
	}
	const media = Math.max(1, wholeCount(visibleMedia));
	const scale = shownScale > 0 && shownScale <= 1 ? shownScale : 1;
	const canvasBytes = drawnFrameBytes * scale * scale;
	const decodedFrames = STREAM_DECODED_FRAMES - (keepsDecoded ? 0 : KEPT_DECODED_FRAMES);
	const perStream = decodedFrames * decodedFrameBytes + STREAM_SHOWN_CANVASES * canvasBytes;
	const room = budgetBytes / media - Math.max(0, wholeCount(mediaCanvases)) * canvasBytes;
	const fits = Math.floor(room / perStream);
	return Math.max(1, Math.min(Math.floor(maxPerMedia), fits));
}

/** What the release decision needs to know about one stream. */
export type ReleaseView = {
	mediaId: string;
	/** Requests queued and not finished: a busy stream is never evicted. */
	pending: number;
	/** Activity time (ms) of its newest request. */
	lastUsed: number;
};

/**
 * The stream to dispose while there are more than `maxTotal`: the least
 * recently used IDLE stream of a media with more streams than its quota (a
 * media missing from `quotaByMedia` has a quota of 0); lowest index on a
 * tie. Null when the streams fit or none may go (soft bound).
 */
export function chooseStreamToRelease({
	streams,
	quotaByMedia,
	maxTotal,
}: {
	streams: ReleaseView[];
	quotaByMedia: ReadonlyMap<string, number>;
	maxTotal: number;
}): number | null {
	if (!(streams.length > maxTotal)) return null;
	const counts = new Map<string, number>();
	for (const stream of streams) {
		counts.set(stream.mediaId, (counts.get(stream.mediaId) ?? 0) + 1);
	}
	let victim: number | null = null;
	for (let index = 0; index < streams.length; index++) {
		const stream = streams[index];
		if (stream.pending > 0) continue;
		const over = (counts.get(stream.mediaId) ?? 0) > (quotaByMedia.get(stream.mediaId) ?? 0);
		if (!over) continue;
		if (victim === null || stream.lastUsed < streams[victim].lastUsed) victim = index;
	}
	return victim;
}

/**
 * Whether a clip's request goes to its own stream before the drawn-frame
 * cache: when the stream reaches `time` without a restart (not before the
 * frame it shows, at most `continueSeconds` past its newest request, and,
 * for an exact request, not a redraw of the frame it shows at a larger
 * size). Answering such a request from frames another clip of the file drew
 * leaves the clip's decoder behind, and the next request it cannot get from
 * there restarts it. A time the stream would restart for (scrubbing back, a
 * jump) still comes from the drawn-frame cache first.
 */
export function ownStreamFirst({
	time,
	scale,
	maxStaleSeconds,
	position,
	shown,
	continueSeconds,
}: {
	time: number;
	scale: number;
	maxStaleSeconds: number;
	/** Media time of the stream's newest request (NaN: none). */
	position: number;
	/** The frame on its canvas. */
	shown: { timestamp: number; duration: number; scale: number } | null;
	continueSeconds: number;
}): boolean {
	const from = shown ? Math.min(shown.timestamp, position) : position;
	if (!(time >= from && time - position <= continueSeconds)) return false;
	if (!shown || time >= shown.timestamp + shown.duration) return true;
	return !needsLargerDraw({ drawnScale: shown.scale, scale, maxStaleSeconds });
}
