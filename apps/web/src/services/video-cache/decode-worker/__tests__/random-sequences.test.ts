import { describe, expect, test } from "bun:test";
import type { ClientFrame, ClientIterator } from "../client";
import { createRandom, createWorld, settleHops } from "./harness";

/** Seeds and steps are fixed: the same sequences run every time. */
const SEEDS = 40;
const STEPS = 80;

/**
 * Seeded random sequences of iterate / pull / render / close / return /
 * dispose over a fake channel (structured clone, setImmediate delivery,
 * transfer marks). Whatever the order, every sample the worker decoded is
 * closed exactly once, every picture is either closed by its consumer or
 * discarded exactly once, and the worker ends up holding nothing.
 */
async function runSequence({ seed }: { seed: number }) {
	const world = createWorld({ backendOptions: { frames: 90 } });
	const random = createRandom(seed);
	await world.client.openStream({ streamId: 1, file: { name: "clip.mp4" } });

	const iterators: ClientIterator[] = [];
	const handles: ClientFrame[] = [];
	const pulls: Array<Promise<void>> = [];
	const renders: Array<Promise<void>> = [];
	const received: number[] = [];

	const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];

	function pull(iterator: ClientIterator): void {
		pulls.push(
			iterator.next().then(
				(result) => {
					if (!result.done) handles.push(result.value);
				},
				() => {},
			),
		);
	}

	function render({ handle }: { handle: ClientFrame }): void {
		const scale = pick([0.25, 0.5, 1]) ?? 1;
		renders.push(
			handle.render({ scale }).then(
				(image) => {
					// the consumer shows the picture and lets go of it
					const id = world.book.idOf(image.kind === "bitmap" ? image.bitmap : image.frame);
					received.push(id);
					world.book.close(id);
				},
				() => {},
			),
		);
	}

	for (let step = 0; step < STEPS; step++) {
		const roll = random();
		if (roll < 0.15 && iterators.length < 3) {
			iterators.push(world.client.openIterator({ streamId: 1, startTime: random() * 2 }));
		} else if (roll < 0.45) {
			const iterator = pick(iterators);
			if (iterator) pull(iterator);
		} else if (roll < 0.65) {
			const handle = pick(handles);
			if (handle) render({ handle });
		} else if (roll < 0.8) {
			const handle = pick(handles);
			if (handle) {
				handle.close();
				if (random() < 0.2) handle.close();
				handles.splice(handles.indexOf(handle), 1);
			}
		} else if (roll < 0.9) {
			const iterator = pick(iterators);
			if (iterator) {
				void iterator.return();
				iterators.splice(iterators.indexOf(iterator), 1);
			}
		} else {
			await settleHops(Math.floor(random() * 3));
		}
	}

	// the end: stop every decoder, close every frame left, drop the stream
	for (const iterator of iterators) void iterator.return();
	await settleHops(4);
	for (const handle of handles) handle.close();
	await settleHops(10);
	// Before the stream is disposed (which closes whatever is left): the worker holds
	// nothing the main thread forgot, late frames included.
	const leftBeforeDispose = world.core.stats().openFrames;
	world.client.disposeStream({ streamId: 1 });
	await settleHops(10);
	await Promise.all([...pulls, ...renders]);

	return { world, leftBeforeDispose };
}

describe("decode worker: seeded random sequences", () => {
	test("every sample closed exactly once, every picture closed or discarded exactly once", async () => {
		let late = 0;
		let samples = 0;
		for (let seed = 1; seed <= SEEDS; seed++) {
			const { world, leftBeforeDispose } = await runSequence({ seed });
			const label = `seed ${seed}`;
			expect([label, leftBeforeDispose]).toEqual([label, 0]);
			expect([label, world.fake.log.doubleClosed]).toEqual([label, 0]);
			expect([label, world.fake.log.closed.size]).toEqual([label, world.fake.log.created]);
			expect([label, [...world.fake.log.closed.values()].every((count) => count === 1)]).toEqual([label, true]);
			expect([label, world.fake.log.renderedClosed]).toEqual([label, 0]);
			expect([label, world.core.stats().openFrames]).toEqual([label, 0]);
			expect([label, world.core.stats().openIterators]).toEqual([label, 0]);
			expect([label, world.core.stats().openStreams]).toEqual([label, 0]);
			// every picture the worker made was transferred, and closed once on this side
			for (const image of world.fake.log.images) {
				expect([label, image.id, image.detached]).toEqual([label, image.id, true]);
				expect([label, image.id, world.book.closes.get(image.id)]).toEqual([label, image.id, 1]);
			}
			expect([label, world.fake.log.disposed]).toEqual([label, 1]);
			late += world.client.stats().lateFrames;
			samples += world.fake.log.created;
		}
		// the sequences really exercise the races they are for
		expect(samples).toBeGreaterThan(500);
		expect(late).toBeGreaterThan(0);
	});
});
