"use client";

import { useEffect, useRef, type ComponentProps } from "react";
import { registerCanceller } from "@/editor/cancel-interaction";
import { useEditor } from "@/editor/use-editor";
import { NumberField } from "@/components/ui/number-field";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import {
	dragPosition,
	getFillSpan,
	getKeyboardValue,
	positionToValue,
	valueToPosition,
	type NumberSliderSpec,
} from "@/params/slider";
import {
	clamp,
	formatNumberForDisplay,
	getFractionDigitsForStep,
} from "@/utils/math";
import { cn } from "@/utils/ui";

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
	"Shift",
	"Control",
	"Alt",
	"Meta",
]);

interface SliderFieldProps {
	/** Current value in display space (the space of `slider`, `step` and `onPreview`). */
	value: number;
	slider: NumberSliderSpec;
	step: number;
	/** Accessible name; use the visible label of the field. */
	label: string;
	/** Unit spoken after the value by screen readers (e.g. "dB"). */
	unit?: string;
	onPreview: (value: number) => void;
	onCommit: () => void;
	/**
	 * Drops the pending preview (Escape during a drag, a drag that ended where it
	 * started, unmount). Defaults to discarding the timeline preview overlay, which
	 * is where every `onPreview` of the properties panel writes.
	 */
	onCancel?: () => void;
	onReset?: () => void;
	fieldProps: ComponentProps<typeof NumberField>;
}

/**
 * A draggable bar next to the exact-value number box. The bar only calls
 * `onPreview` while the pointer or key is active and `onCommit` once when it ends
 * (`onCancel` when nothing changed), so one drag or one held key is one undo step.
 */
export function SliderField({ fieldProps, label, ...bar }: SliderFieldProps) {
	// The bar is never hidden. From 12.5rem (200px = bar 96px + gap + box 96px) up
	// they share one row; below it both take a full row, so the bar and the box
	// stack. Tailwind needs the literal `@[12.5rem]` in each class.
	return (
		<div className="@container flex flex-wrap items-center gap-x-2 gap-y-1">
			<SliderBar
				{...bar}
				label={label}
				className="w-full @[12.5rem]:w-auto @[12.5rem]:flex-1"
			/>
			<NumberField
				className="w-full @[12.5rem]:w-24 @[12.5rem]:shrink-0"
				aria-label={label}
				{...fieldProps}
			/>
		</div>
	);
}

function SliderBar({
	value,
	slider,
	step,
	label,
	unit,
	onPreview,
	onCommit,
	onCancel,
	onReset,
	className,
}: Omit<SliderFieldProps, "fieldProps"> & { className?: string }) {
	const trackRef = useRef<HTMLDivElement>(null);
	const thumbRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		pointerId: number;
		startPosition: number;
		startX: number;
		trackPx: number;
		position: number;
		fine: boolean;
	} | null>(null);
	/** Last value sent since the previous commit: null means nothing is waiting to be committed. */
	const previewedRef = useRef<number | null>(null);
	/** Value before the first preview of the current drag or key press. */
	const startValueRef = useRef(value);
	const pendingRef = useRef<number | null>(null);
	const frameRef = useRef(0);
	const releaseCancellerRef = useRef<(() => void) | null>(null);
	const resetArmedRef = useRef(false);
	const editor = useEditor();
	const handlersRef = useCommittedRef({
		onPreview,
		onCommit,
		onCancel: onCancel ?? (() => editor.timeline.discardPreview()),
	});

	const releaseCanceller = () => {
		releaseCancellerRef.current?.();
		releaseCancellerRef.current = null;
	};

	const flush = () => {
		cancelAnimationFrame(frameRef.current);
		frameRef.current = 0;
		if (pendingRef.current === null) return;
		const next = pendingRef.current;
		pendingRef.current = null;
		handlersRef.current.onPreview(next);
	};

	const preview = (next: number) => {
		if (next === (previewedRef.current ?? value)) return;
		if (previewedRef.current === null) startValueRef.current = value;
		previewedRef.current = next;
		pendingRef.current = next;
		frameRef.current ||= requestAnimationFrame(flush);
	};

	/** Ends the interaction with one undo step, or none when the value is back where it started. */
	const commit = () => {
		flush();
		const previewed = previewedRef.current;
		if (previewed === null) return;
		previewedRef.current = null;
		if (previewed === startValueRef.current) handlersRef.current.onCancel();
		else handlersRef.current.onCommit();
	};

	const cancel = () => {
		cancelAnimationFrame(frameRef.current);
		frameRef.current = 0;
		pendingRef.current = null;
		dragRef.current = null;
		releaseCanceller();
		if (previewedRef.current === null) return;
		previewedRef.current = null;
		handlersRef.current.onCancel();
	};
	const cancelRef = useCommittedRef(cancel);
	useEffect(() => () => cancelRef.current(), [cancelRef]);

	// Hit-tests by geometry: while the pointer is captured, or while the focus lock
	// disables pointer events on children, event.target is the bar itself.
	const isOverThumb = ({
		clientX,
		clientY,
	}: {
		clientX: number;
		clientY: number;
	}) => {
		const rect = thumbRef.current?.getBoundingClientRect();
		return (
			rect !== undefined &&
			clientX >= rect.left &&
			clientX <= rect.right &&
			clientY >= rect.top &&
			clientY <= rect.bottom
		);
	};

	const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const track = trackRef.current;
		if (event.button !== 0 || !track || dragRef.current) return;
		const { left, width } = track.getBoundingClientRect();
		if (width <= 0) return;
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);

		const onThumb = isOverThumb(event);
		const startPosition = onThumb
			? valueToPosition({ value, spec: slider })
			: dragPosition({
					startPosition: 0,
					deltaPx: event.clientX - left,
					trackPx: width,
					fine: false,
				});
		dragRef.current = {
			pointerId: event.pointerId,
			startPosition,
			startX: event.clientX,
			trackPx: width,
			position: startPosition,
			fine: event.shiftKey,
		};
		releaseCancellerRef.current = registerCanceller({ fn: cancel });
		if (!onThumb) {
			preview(positionToValue({ position: startPosition, spec: slider, step }));
		}
	};

	const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		if (event.shiftKey !== drag.fine) {
			// Rebase on a Shift toggle so the thumb does not jump.
			drag.startPosition = drag.position;
			drag.startX = event.clientX;
			drag.fine = event.shiftKey;
		}
		drag.position = dragPosition({
			startPosition: drag.startPosition,
			deltaPx: event.clientX - drag.startX,
			trackPx: drag.trackPx,
			fine: drag.fine,
		});
		preview(positionToValue({ position: drag.position, spec: slider, step }));
	};

	const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		dragRef.current = null;
		releaseCanceller();
		commit();
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const next = getKeyboardValue({
			key: event.key,
			shiftKey: event.shiftKey,
			value: previewedRef.current ?? value,
			step,
			spec: slider,
		});
		if (next === null) return;
		event.preventDefault();
		preview(next);
		flush();
	};

	const commitIfIdle = () => {
		if (!dragRef.current) commit();
	};

	const { start, end } = getFillSpan({ value, spec: slider });
	const valueText = formatNumberForDisplay({
		value,
		maxFractionDigits: getFractionDigitsForStep({ step }),
	});

	return (
		<div
			role="slider"
			tabIndex={0}
			aria-label={label}
			aria-valuemin={slider.min}
			aria-valuemax={slider.max}
			aria-valuenow={clamp({ value, min: slider.min, max: slider.max })}
			aria-valuetext={unit ? `${valueText} ${unit}` : valueText}
			className={cn(
				"group flex h-7 cursor-ew-resize touch-none items-center px-2 outline-none select-none",
				className,
			)}
			onMouseDown={(event) => {
				// Keeps the browser from starting text selection or an HTML drag of a
				// draggable ancestor (the effects list item) from the bar.
				event.preventDefault();
				// A double-click resets only when it started on the thumb, not on a
				// track click that already jumped the value.
				if (event.detail === 1) resetArmedRef.current = isOverThumb(event);
			}}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onLostPointerCapture={endDrag}
			onKeyDown={handleKeyDown}
			onKeyUp={(event) => {
				if (!MODIFIER_KEYS.has(event.key)) commitIfIdle();
			}}
			onBlur={commitIfIdle}
			onDoubleClick={(event) => {
				if (onReset && resetArmedRef.current && isOverThumb(event)) onReset();
			}}
		>
			<div
				ref={trackRef}
				className="bg-accent relative h-1.5 w-full rounded-full"
			>
				<div
					className="bg-primary absolute inset-y-0 rounded-full"
					style={{
						left: `${start * 100}%`,
						width: `${(end - start) * 100}%`,
					}}
				/>
				<div
					ref={thumbRef}
					className="border-primary/50 bg-background group-focus-visible:ring-ring absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border shadow-sm group-focus-visible:ring-2"
					style={{ left: `${valueToPosition({ value, spec: slider }) * 100}%` }}
				/>
			</div>
		</div>
	);
}
