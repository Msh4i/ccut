/**
 * B1 of the "Stick to scene" e2e: a press on the rotate handle followed by a
 * move of a few pixels made the browser start a native drag of the handle's
 * icon (it fired `dragstart`, then `pointercancel`, then `pointerleave`, which
 * ended the gesture after two moves: a 20 degree pull turned the element 3.3).
 * Nothing about a handle may ever be draggable or selectable.
 */
import { describe, expect, test } from "bun:test";
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { Rotate01Icon } from "@hugeicons/core-free-icons";
import {
	BoundingBoxOutline,
	CanvasPathOutline,
	CircleHandle,
	CornerHandle,
	EdgeHandle,
	HandleButton,
	IconHandle,
	LineOverlay,
	ShapeOutline,
} from "../handle-primitives";

const noop = () => {};
const common = { screen: { x: 40, y: 60 }, onPointerDown: noop, onPointerMove: noop, onPointerUp: noop };

type EventHandler = (event: unknown) => void;

interface ButtonProps {
	className?: string;
	draggable?: boolean;
	onDragStart?: (event: { preventDefault: () => void }) => void;
	onPointerUp?: EventHandler;
	onPointerCancel?: EventHandler;
	onLostPointerCapture?: EventHandler;
	onPointerLeave?: EventHandler;
	children?: ReactNode;
}

type Render = (props: unknown) => unknown;

function isFunctionComponent(type: unknown): type is Render {
	return typeof type === "function";
}

function hasHandlerProps(element: ReactElement): element is ReactElement<ButtonProps> {
	return typeof element.props === "object" && element.props !== null;
}

function isButton(element: ReactElement): element is ReactElement<ButtonProps, "button"> {
	return element.type === "button";
}

/** The <button> a handle renders: the handle components are plain functions, rendered down to the intrinsic element. */
function buttonOf({ handle }: { handle: ReactElement }): ReactElement<ButtonProps, "button"> {
	let element: ReactElement = handle;
	for (let depth = 0; depth < 5 && isFunctionComponent(element.type); depth++) {
		const next = element.type(element.props);
		if (!isValidElement(next)) throw new Error("a handle component did not render an element");
		element = next;
	}
	if (!isButton(element)) throw new Error(`expected a <button>, got ${String(element.type)}`);
	return element;
}

function dragStartIsPrevented({ button }: { button: ReactElement<ButtonProps, "button"> }): boolean {
	let prevented = false;
	button.props.onDragStart?.({
		preventDefault: () => {
			prevented = true;
		},
	});
	return prevented;
}

describe("transform handles cannot be dragged or selected by the browser", () => {
	const handles: Record<string, ReactElement> = {
		corner: <CornerHandle {...common} />,
		edge: <EdgeHandle {...common} edge="right" rotation={0} />,
		circle: <CircleHandle {...common} />,
		icon: <IconHandle {...common} icon={Rotate01Icon} />,
		base: <HandleButton {...common} hitAreaSize={18}>x</HandleButton>,
	};

	for (const [name, handle] of Object.entries(handles)) {
		test(`${name} handle: dragstart is cancelled before it can cancel the pointer`, () => {
			expect(dragStartIsPrevented({ button: buttonOf({ handle }) })).toBe(true);
		});

		test(`${name} handle: not draggable, no text selection, no touch panning`, () => {
			const button = buttonOf({ handle });
			expect(button.props.draggable).toBe(false);
			expect(button.props.className).toContain("select-none");
			expect(button.props.className).toContain("touch-none");
		});
	}

	test("the rotate handle's icon never takes the press itself (the button is always the event target)", () => {
		const button = buttonOf({ handle: handles.icon });
		const icon = button.props.children;
		expect(isValidElement(icon)).toBe(true);
		const iconProps = isValidElement<{ className?: string }>(icon) ? icon.props : {};
		expect(iconProps.className).toContain("pointer-events-none");
	});
});

// ---------------------------------------------------------------------------
// How a gesture on a handle ends
// ---------------------------------------------------------------------------

/**
 * M2 of the review: `onPointerLeave={onPointerUp}` was in effect the ONLY end
 * handler besides pointerup. The controllers capture the pointer, so the
 * browser sends `pointerleave` only once the capture is gone: after a
 * `pointercancel` or a `lostpointercapture`, which then ended the gesture at
 * the angle reached so far with nothing said (one rotate gesture stopped at
 * 15.1 degrees of 20, an unstuck control at 11.8). The ends that must finish a
 * gesture are the ones that say so: up, cancel, lost capture. Leaving the
 * element with a button still down is not an end.
 */
describe("a gesture on a handle ends on pointerup, pointercancel and lostpointercapture, not on pointerleave", () => {
	const kinds: Array<[string, (props: { onPointerUp: EventHandler }) => ReactElement]> = [
		["corner", (props) => <CornerHandle {...common} {...props} />],
		["edge", (props) => <EdgeHandle {...common} {...props} edge="right" rotation={0} />],
		["circle", (props) => <CircleHandle {...common} {...props} />],
		["icon", (props) => <IconHandle {...common} {...props} icon={Rotate01Icon} />],
		["base", (props) => <HandleButton {...common} {...props} hitAreaSize={18}>x</HandleButton>],
	];

	for (const [name, build] of kinds) {
		test(`${name} handle: cancel and lost capture are the same end as pointerup`, () => {
			const ended: unknown[] = [];
			const button = buttonOf({ handle: build({ onPointerUp: (event) => ended.push(event) }) });
			const up = { type: "pointerup" };
			const cancel = { type: "pointercancel" };
			const lost = { type: "lostpointercapture" };
			button.props.onPointerUp?.(up);
			button.props.onPointerCancel?.(cancel);
			button.props.onLostPointerCapture?.(lost);
			// each handler is wired, and each one hands over its own event
			expect(ended).toEqual([up, cancel, lost]);
		});

		test(`${name} handle: leaving the button is not an end`, () => {
			const button = buttonOf({ handle: build({ onPointerUp: () => {} }) });
			expect(button.props.onPointerLeave).toBeUndefined();
			expect("onPointerLeave" in button.props).toBe(false);
		});
	}
});

describe("the outlines of the mask handles end the same way (they capture the pointer too)", () => {
	const endProps = { onPointerDown: noop, onPointerMove: noop };
	const pathData = "M0 0 L1 1";

	/** The element that carries the outline's handlers: the <svg>, or the hit area <div> of a line. */
	function carrierOf({ element }: { element: ReactElement }): ReactElement<ButtonProps> {
		let current: ReactElement = element;
		for (let depth = 0; depth < 5 && isFunctionComponent(current.type); depth++) {
			const next = current.type(current.props);
			if (!isValidElement(next)) throw new Error("an outline did not render an element");
			current = next;
		}
		if (current.type === Fragment) {
			const first = Children.toArray(isValidElement<{ children?: ReactNode }>(current) ? current.props.children : []).find(isValidElement);
				if (!first) throw new Error("a fragment without an element");
			current = first;
		}
		if (!hasHandlerProps(current)) throw new Error("an outline without props");
		return current;
	}

	const outlines: Array<[string, (props: { onPointerUp: EventHandler }) => ReactElement]> = [
		["bounding box", (props) => <BoundingBoxOutline center={{ x: 0, y: 0 }} outlineWidth={10} outlineHeight={10} rotation={0} {...endProps} {...props} />],
		["shape", (props) => <ShapeOutline center={{ x: 0, y: 0 }} outlineWidth={10} outlineHeight={10} rotation={0} pathData={pathData} {...endProps} {...props} />],
		["canvas path", (props) => <CanvasPathOutline pathData={pathData} {...endProps} {...props} />],
		["line", (props) => <LineOverlay start={{ x: 0, y: 0 }} end={{ x: 10, y: 0 }} {...endProps} {...props} />],
	];

	for (const [name, build] of outlines) {
		test(`${name}: cancel and lost capture end the gesture, leaving does not`, () => {
			const ended: unknown[] = [];
			const carrier = carrierOf({ element: build({ onPointerUp: (event) => ended.push(event) }) });
			const up = { type: "pointerup" };
			const cancel = { type: "pointercancel" };
			const lost = { type: "lostpointercapture" };
			carrier.props.onPointerUp?.(up);
			carrier.props.onPointerCancel?.(cancel);
			carrier.props.onLostPointerCapture?.(lost);
			expect(ended).toEqual([up, cancel, lost]);
			expect("onPointerLeave" in carrier.props).toBe(false);
		});
	}
});
