import { describe, expect, test } from "bun:test";
import { createFocusModality } from "../focus-modality";
import {
	isActivationKey,
	shouldLeaveKeyToTarget,
	type InteractiveTargetCandidate,
} from "../interactive-target";

function el({
	tag,
	role,
	type,
	href,
	editable = false,
	parent = null,
}: {
	tag: string;
	role?: string;
	type?: string;
	href?: string;
	editable?: boolean;
	parent?: InteractiveTargetCandidate | null;
}): InteractiveTargetCandidate {
	const attributes: Record<string, string | undefined> = { role, type, href };
	return {
		tagName: tag,
		isContentEditable: editable,
		getAttribute: (name) => attributes[name] ?? null,
		parentElement: parent,
	};
}

interface Press {
	key: string;
	target: InteractiveTargetCandidate | null;
	keyboardFocus: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
}

function decide({
	key,
	target,
	keyboardFocus,
	ctrlKey = false,
	metaKey = false,
	altKey = false,
}: Press): boolean {
	return shouldLeaveKeyToTarget({
		key,
		ctrlKey,
		metaKey,
		altKey,
		target,
		keyboardFocus,
	});
}

/**
 * Mirrors the order use-keybindings.ts uses for every keydown: the modality
 * tracker sees the key first, then the decision runs with the tracker state.
 */
function createSession() {
	const modality = createFocusModality();
	return {
		pointerDown: () => modality.onPointerDown(),
		press: ({
			key,
			target,
			ctrlKey,
			metaKey,
			altKey,
		}: Omit<Press, "keyboardFocus">): boolean => {
			modality.onKeyDown({ key });
			return decide({
				key,
				target,
				ctrlKey,
				metaKey,
				altKey,
				keyboardFocus: modality.isKeyboard(),
			});
		},
	};
}

const button = el({ tag: "BUTTON" });
const body = el({ tag: "BODY" });

describe("isActivationKey", () => {
	test("Enter, Space and legacy Spacebar activate", () => {
		expect(isActivationKey({ key: "Enter" })).toBe(true);
		expect(isActivationKey({ key: " " })).toBe(true);
		expect(isActivationKey({ key: "Spacebar" })).toBe(true);
	});

	test("other keys do not", () => {
		for (const key of ["Escape", "Tab", "k", "Home", "", "space"]) {
			expect(isActivationKey({ key })).toBe(false);
		}
	});
});

describe("scenarios through the modality tracker", () => {
	test("(a) fresh page, button focused, Enter is left to the button", () => {
		const session = createSession();
		expect(session.press({ key: "Enter", target: button })).toBe(true);
	});

	test("(b) after a pointerdown, Space on a button fires the global shortcut", () => {
		const session = createSession();
		session.pointerDown();
		expect(session.press({ key: " ", target: button })).toBe(false);
	});

	test("(c) pointerdown, Tab, Space on a button is left to the button", () => {
		const session = createSession();
		session.pointerDown();
		session.press({ key: "Tab", target: button });
		expect(session.press({ key: " ", target: button })).toBe(true);
	});

	test("(d) pointerdown, Tab, pointerdown again, Space fires the shortcut", () => {
		const session = createSession();
		session.pointerDown();
		session.press({ key: "Tab", target: button });
		session.pointerDown();
		expect(session.press({ key: " ", target: button })).toBe(false);
	});

	test("(e) a text input leaves Enter and Space in every modality", () => {
		const input = el({ tag: "INPUT", type: "text" });
		const session = createSession();
		expect(session.press({ key: " ", target: input })).toBe(true);
		session.pointerDown();
		expect(session.press({ key: " ", target: input })).toBe(true);
		expect(session.press({ key: "Enter", target: input })).toBe(true);
		session.press({ key: "Tab", target: input });
		expect(session.press({ key: "Enter", target: input })).toBe(true);
	});

	test("(i) Space handled globally does not flip the modality back", () => {
		const session = createSession();
		session.pointerDown();
		expect(session.press({ key: " ", target: button })).toBe(false);
		expect(session.press({ key: " ", target: button })).toBe(false);
		expect(session.press({ key: "Enter", target: button })).toBe(false);
	});

	test("a click on a clip keeps Space as play, a Tab to Split gives Space to Split", () => {
		const clip = el({ tag: "BUTTON" });
		const split = el({ tag: "BUTTON" });
		const session = createSession();
		session.pointerDown();
		expect(session.press({ key: " ", target: clip })).toBe(false);
		session.press({ key: "Tab", target: split });
		expect(session.press({ key: " ", target: split })).toBe(true);
		expect(session.press({ key: "Enter", target: split })).toBe(true);
	});
});

describe("text-entry targets", () => {
	const textTargets: Array<[string, InteractiveTargetCandidate]> = [
		["input without a type", el({ tag: "INPUT" })],
		["input type=text", el({ tag: "INPUT", type: "text" })],
		["input type=number", el({ tag: "INPUT", type: "number" })],
		["input type=search", el({ tag: "INPUT", type: "search" })],
		["input type=password", el({ tag: "INPUT", type: "password" })],
		["input with an upper-case type", el({ tag: "INPUT", type: "TEXT" })],
		["textarea", el({ tag: "TEXTAREA" })],
		["select", el({ tag: "SELECT" })],
		["contenteditable div", el({ tag: "DIV", editable: true })],
		[
			"child of a contenteditable",
			el({ tag: "SPAN", parent: el({ tag: "DIV", editable: true }) }),
		],
	];

	for (const [name, target] of textTargets) {
		for (const keyboardFocus of [true, false]) {
			test(`${name} keeps Enter and Space (keyboardFocus=${keyboardFocus})`, () => {
				expect(decide({ key: "Enter", target, keyboardFocus })).toBe(true);
				expect(decide({ key: " ", target, keyboardFocus })).toBe(true);
			});
		}
	}
});

describe("click-activated controls follow keyboardFocus", () => {
	const controls: Array<[string, InteractiveTargetCandidate]> = [
		["button", el({ tag: "BUTTON" })],
		["lower-case button tag", el({ tag: "button" })],
		["a[href]", el({ tag: "A", href: "/x" })],
		["summary", el({ tag: "SUMMARY" })],
		["svg inside a button", el({ tag: "svg", parent: el({ tag: "BUTTON" }) })],
		...[
			"button",
			"submit",
			"reset",
			"checkbox",
			"radio",
			"image",
			"file",
			"color",
		].map((type): [string, InteractiveTargetCandidate] => [
			`input type=${type}`,
			el({ tag: "INPUT", type }),
		]),
		...[
			"button",
			"tab",
			"menuitem",
			"menuitemcheckbox",
			"menuitemradio",
			"checkbox",
			"radio",
			"switch",
			"option",
			"link",
			"combobox",
			"spinbutton",
		].map((role): [string, InteractiveTargetCandidate] => [
			`div role=${role}`,
			el({ tag: "DIV", role }),
		]),
		["role with spaces and capitals", el({ tag: "DIV", role: " Option " })],
	];

	for (const [name, target] of controls) {
		test(`${name} leaves Enter and Space only for keyboard focus`, () => {
			expect(decide({ key: "Enter", target, keyboardFocus: true })).toBe(true);
			expect(decide({ key: " ", target, keyboardFocus: true })).toBe(true);
			expect(decide({ key: "Spacebar", target, keyboardFocus: true })).toBe(
				true,
			);
			expect(decide({ key: "Enter", target, keyboardFocus: false })).toBe(
				false,
			);
			expect(decide({ key: " ", target, keyboardFocus: false })).toBe(false);
			expect(decide({ key: "Spacebar", target, keyboardFocus: false })).toBe(
				false,
			);
		});
	}
});

describe("(f) sliders keep Enter and Space for the global shortcuts", () => {
	const sliders: Array<[string, InteractiveTargetCandidate]> = [
		["input type=range", el({ tag: "INPUT", type: "range" })],
		["input type=RANGE", el({ tag: "INPUT", type: "RANGE" })],
		["div role=slider", el({ tag: "DIV", role: "slider" })],
		["role=slider with spaces", el({ tag: "DIV", role: " Slider " })],
		[
			"role=slider with a fallback role",
			el({ tag: "DIV", role: "slider button" }),
		],
		[
			"child of a slider",
			el({ tag: "SPAN", parent: el({ tag: "DIV", role: "slider" }) }),
		],
	];

	for (const [name, target] of sliders) {
		for (const keyboardFocus of [true, false]) {
			test(`${name} (keyboardFocus=${keyboardFocus})`, () => {
				expect(decide({ key: "Enter", target, keyboardFocus })).toBe(false);
				expect(decide({ key: " ", target, keyboardFocus })).toBe(false);
			});
		}
	}

	test("a slider inside an option row still counts as a slider", () => {
		const row = el({ tag: "DIV", role: "option" });
		const slider = el({ tag: "DIV", role: "slider", parent: row });
		expect(decide({ key: " ", target: slider, keyboardFocus: true })).toBe(
			false,
		);
	});
});

describe("(g) ctrl, meta and alt keep user-bindable shortcuts working", () => {
	const targets: Array<[string, InteractiveTargetCandidate]> = [
		["button", button],
		["text input", el({ tag: "INPUT", type: "text" })],
		["role=option", el({ tag: "DIV", role: "option" })],
	];
	const modifiers = [
		{ ctrlKey: true },
		{ metaKey: true },
		{ altKey: true },
		{ ctrlKey: true, altKey: true },
	];

	for (const [name, target] of targets) {
		for (const key of ["Enter", " "]) {
			for (const modifier of modifiers) {
				test(`${name}: ${JSON.stringify(modifier)} + ${JSON.stringify(key)} is not left`, () => {
					expect(
						decide({ key, target, keyboardFocus: true, ...modifier }),
					).toBe(false);
				});
			}
		}
	}
});

describe("(h) non-activation keys never leave the key to the target", () => {
	const targets: Array<[string, InteractiveTargetCandidate]> = [
		["button", button],
		["text input", el({ tag: "INPUT", type: "text" })],
		["textarea", el({ tag: "TEXTAREA" })],
		["slider", el({ tag: "DIV", role: "slider" })],
		["contenteditable", el({ tag: "DIV", editable: true })],
	];

	for (const [name, target] of targets) {
		test(`${name}: Home, k, Escape, Tab, Delete, letters`, () => {
			for (const key of [
				"Home",
				"k",
				"Escape",
				"Tab",
				"Delete",
				"s",
				"ArrowLeft",
			]) {
				for (const keyboardFocus of [true, false]) {
					expect(decide({ key, target, keyboardFocus })).toBe(false);
				}
			}
		});
	}
});

describe("targets that are not controls", () => {
	test("Enter and Space on the body or a plain div fire the shortcut", () => {
		const preview = el({ tag: "DIV", parent: body });
		for (const target of [body, preview, null]) {
			for (const keyboardFocus of [true, false]) {
				expect(decide({ key: "Enter", target, keyboardFocus })).toBe(false);
				expect(decide({ key: " ", target, keyboardFocus })).toBe(false);
			}
		}
	});

	test("an anchor without href is not a control", () => {
		expect(
			decide({ key: " ", target: el({ tag: "A" }), keyboardFocus: true }),
		).toBe(false);
	});

	test("an unrelated role is not a control", () => {
		expect(
			decide({
				key: " ",
				target: el({ tag: "DIV", role: "region" }),
				keyboardFocus: true,
			}),
		).toBe(false);
	});

	test("an ancestor control decides for a plain focused child", () => {
		const option = el({ tag: "DIV", role: "option" });
		const child = el({ tag: "DIV", parent: option });
		expect(decide({ key: " ", target: child, keyboardFocus: true })).toBe(true);
		expect(decide({ key: " ", target: child, keyboardFocus: false })).toBe(
			false,
		);
	});

	test("a very deep tree without controls terminates and is not a control", () => {
		let node: InteractiveTargetCandidate = el({ tag: "DIV" });
		for (let index = 0; index < 500; index++) {
			node = el({ tag: "DIV", parent: node });
		}
		expect(decide({ key: " ", target: node, keyboardFocus: true })).toBe(false);
	});
});
