import { describe, expect, test } from "bun:test";
import { ImageLease } from "../image-lease";

type FakeBitmap = { id: number };

function createLease({ quarantine = 3 }: { quarantine?: number } = {}) {
	const clock = { draws: 0 };
	const closed: number[] = [];
	const held = new Set<FakeBitmap>();
	const lease = new ImageLease<FakeBitmap>({
		close: (image) => closed.push(image.id),
		quarantine: () => quarantine,
		clock,
		isHeld: (image) => held.has(image),
	});
	return { lease, clock, closed, held };
}

describe("ImageLease", () => {
	test("a released picture nobody was given is closed at once, once", () => {
		const { lease, closed } = createLease();
		const image = { id: 1 };
		lease.adopt({ image, scale: 0.5 });
		expect(lease.owns(image)).toBe(true);
		lease.release(image);
		lease.release(image);
		expect(closed).toEqual([1]);
		expect(lease.owns(image)).toBe(false);
	});

	test("a picture handed out waits for the draws of its quarantine before it is closed", () => {
		const { lease, closed } = createLease({ quarantine: 3 });
		const shown = { id: 1 };
		lease.adopt({ image: shown, scale: 0.5 });
		lease.noteHandOut(shown);
		lease.release(shown);
		expect(closed).toEqual([]);
		// two more draws (other pictures adopted): still in quarantine
		for (const id of [2, 3]) lease.adopt({ image: { id }, scale: 0.5 });
		expect(closed).not.toContain(1);
		lease.adopt({ image: { id: 4 }, scale: 0.5 });
		expect(closed).toContain(1);
		expect(closed.filter((id) => id === 1)).toHaveLength(1);
	});

	test("a picture a render still holds is never closed, whatever its quarantine says", () => {
		const { lease, closed, held } = createLease({ quarantine: 1 });
		const image = { id: 1 };
		held.add(image);
		lease.adopt({ image, scale: 1 });
		lease.noteHandOut(image);
		lease.release(image);
		for (let id = 2; id < 10; id++) lease.adopt({ image: { id }, scale: 1 });
		expect(closed).not.toContain(1);
		held.delete(image);
		lease.trim();
		expect(closed.filter((id) => id === 1)).toHaveLength(1);
	});

	test("memory follows the area of every picture alive until it is closed", () => {
		const { lease } = createLease({ quarantine: 1 });
		const small = { id: 1 };
		const big = { id: 2 };
		lease.adopt({ image: small, scale: 0.5 });
		lease.adopt({ image: big, scale: 1 });
		expect(lease.liveBytes({ fullBytes: 1000 })).toBe(250 + 1000);
		lease.release(small);
		expect(lease.liveBytes({ fullBytes: 1000 })).toBe(1000);
	});

	test("adopting a picture twice counts it once", () => {
		const { lease, closed } = createLease();
		const image = { id: 1 };
		lease.adopt({ image, scale: 1 });
		lease.adopt({ image, scale: 1 });
		expect(lease.getStats().live).toBe(1);
		lease.release(image);
		expect(closed).toEqual([1]);
	});

	test("clear closes what waits for its quarantine, and only when it is over", () => {
		const { lease, closed } = createLease({ quarantine: 3 });
		const image = { id: 1 };
		lease.adopt({ image, scale: 1 });
		lease.noteHandOut(image);
		lease.release(image);
		lease.clear();
		expect(closed).toEqual([]);
		for (const id of [2, 3, 4]) lease.adopt({ image: { id }, scale: 1 });
		expect(closed).toContain(1);
	});
});
