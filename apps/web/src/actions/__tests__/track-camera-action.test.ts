import { describe, expect, test } from "bun:test";
import {
	ACTIONS,
	getActionDefinition,
	getDefaultShortcuts,
	isActionWithOptionalArgs,
} from "../definitions";

describe("the track-camera action", () => {
	test("is registered for the command list and key bindings, without arguments", () => {
		expect(ACTIONS["track-camera"]).toEqual({
			description: "Track camera of the selected video clip",
			category: "editing",
		});
		expect(isActionWithOptionalArgs("track-camera")).toBe(true);
	});

	test("has no default shortcut (AE has none); the user may bind one", () => {
		expect(getActionDefinition({ action: "track-camera" }).defaultShortcuts).toBeUndefined();
		expect([...getDefaultShortcuts().values()]).not.toContain("track-camera");
	});
});
