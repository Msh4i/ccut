const { describe, expect, test } = require("bun:test");
const { MAX_RELOADS_PER_WINDOW, RELOAD_WINDOW_MS, decideRenderGone } = require("../render-gone");

describe("decideRenderGone", () => {
	test("a clean exit does nothing", () => {
		expect(decideRenderGone({ reason: "clean-exit", exitCode: 0, now: 1000, recentReloads: [] })).toBeNull();
	});

	test("a memory crash reloads the window and says why", () => {
		const decision = decideRenderGone({ reason: "crashed", exitCode: 5, now: 1000, recentReloads: [] });
		expect(decision.reload).toBe(true);
		expect(decision.recent).toEqual([1000]);
		expect(decision.message).toContain("ran out of memory");
		expect(decision.message).toContain("reloaded");
	});

	test("a crash loop stops reloading after two reloads in a minute, and old reloads do not count", () => {
		const now = 10 * RELOAD_WINDOW_MS;
		const looping = decideRenderGone({ reason: "oom", exitCode: 0, now, recentReloads: [now - 5000, now - 1000] });
		expect(MAX_RELOADS_PER_WINDOW).toBe(2);
		expect(looping.reload).toBe(false);
		expect(looping.message).toContain("not reloaded");
		const old = decideRenderGone({ reason: "oom", exitCode: 0, now, recentReloads: [now - RELOAD_WINDOW_MS - 1, now - RELOAD_WINDOW_MS - 2] });
		expect(old.reload).toBe(true);
	});
});
