import { describe, expect, spyOn, test } from "bun:test";
import { OnceWarner, usablePassGroups } from "../pass-groups";
import type { EffectPass } from "../types";

function pass(uniforms: EffectPass["uniforms"]): EffectPass {
	return { shader: "gaussian-blur", uniforms };
}

const GOOD = pass({ u_sigma: 2, u_step: 1, u_direction: [1, 0] });

describe("usablePassGroups", () => {
	test("groups that are all usable come back as they are (no copy per frame)", () => {
		const groups = [[GOOD], [GOOD, GOOD]];
		expect(usablePassGroups(groups)).toBe(groups);
		const none: EffectPass[][] = [];
		expect(usablePassGroups(none)).toBe(none);
	});

	test("an empty group is left out", () => {
		expect(usablePassGroups([[], [GOOD], []])).toEqual([[GOOD]]);
	});

	test("a group left out for a non-finite uniform asks to warn, naming the shader and the uniform", () => {
		const warnOnce = spyOn(OnceWarner.prototype, "warnOnce").mockImplementation(() => true);
		try {
			usablePassGroups([[GOOD, pass({ u_sigma: 2, u_step: Number.NaN })], [GOOD]]);
			expect(warnOnce).toHaveBeenCalledTimes(1);
			const [{ key, message }] = warnOnce.mock.calls[0];
			expect(key).toBe("gaussian-blur:u_step");
			expect(message).toContain('"gaussian-blur"');
			expect(message).toContain('"u_step"');
			expect(message).toContain("exported without it");
		} finally {
			warnOnce.mockRestore();
		}
	});

	test("an effect with nothing to do (no passes) is normal: no warning", () => {
		const warnOnce = spyOn(OnceWarner.prototype, "warnOnce").mockImplementation(() => true);
		try {
			usablePassGroups([[], [GOOD], []]);
			expect(warnOnce).not.toHaveBeenCalled();
		} finally {
			warnOnce.mockRestore();
		}
	});

	test("a group with a non-finite number, alone or in a vector, is left out whole", () => {
		const cases: EffectPass["uniforms"][] = [
			{ u_sigma: Number.NaN, u_step: 1, u_direction: [1, 0] },
			{ u_sigma: 2, u_step: Number.POSITIVE_INFINITY, u_direction: [1, 0] },
			{ u_sigma: 2, u_step: 1, u_direction: [Number.NaN, 0] },
			{ u_sigma: 2, u_step: 1, u_direction: [0, Number.NEGATIVE_INFINITY] },
		];
		for (const uniforms of cases) {
			expect(usablePassGroups([[GOOD, pass(uniforms)], [GOOD]])).toEqual([[GOOD]]);
		}
	});
});

describe("OnceWarner", () => {
	test("says a key once, another key again, and at most `max` keys", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const warner = new OnceWarner({ max: 2 });
			expect(warner.warnOnce({ key: "a", message: "first" })).toBe(true);
			expect(warner.warnOnce({ key: "a", message: "again" })).toBe(false);
			expect(warner.warnOnce({ key: "b", message: "second" })).toBe(true);
			expect(warner.warnOnce({ key: "c", message: "third" })).toBe(false);
			expect(warn.mock.calls.map((call) => call[0])).toEqual(["first", "second"]);
		} finally {
			warn.mockRestore();
		}
	});
});
