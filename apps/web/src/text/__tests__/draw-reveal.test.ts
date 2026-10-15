import { describe, expect, test } from "bun:test";
import type { TextCanvasContext } from "@/text/layout";
import {
	drawMeasuredTextLayout,
	type MeasuredTextLayout,
	type TextAlign,
	type TextDecoration,
} from "@/text/primitives";

// A 2D context that records what is drawn and where. It keeps the pieces of
// canvas state the reveal relies on: text alignment and the translate offset,
// both restored by restore(). Every character is 10 px wide.
type DrawCall =
	| {
			kind: "fillText";
			text: string;
			x: number;
			y: number;
			textAlign: string;
			originX: number;
	  }
	| {
			kind: "fillRect";
			x: number;
			y: number;
			width: number;
			height: number;
			originX: number;
	  }
	| { kind: "roundRect"; x: number; y: number; width: number; height: number };

function createRecordingContext() {
	const calls: DrawCall[] = [];
	const saved: { textAlign: string; originX: number }[] = [];
	const ctx: TextCanvasContext = Object.assign(Object.create(null), {
		font: "",
		textBaseline: "",
		fillStyle: "",
		letterSpacing: "",
		textAlign: "start",
		originX: 0,
		save() {
			saved.push({ textAlign: this.textAlign, originX: this.originX });
		},
		restore() {
			const state = saved.pop();
			if (!state) return;
			this.textAlign = state.textAlign;
			this.originX = state.originX;
		},
		translate(x: number) {
			this.originX += x;
		},
		measureText(text: string) {
			return metrics(text.length * 10);
		},
		fillText(text: string, x: number, y: number) {
			calls.push({
				kind: "fillText",
				text,
				x,
				y,
				textAlign: this.textAlign,
				originX: this.originX,
			});
		},
		fillRect(x: number, y: number, width: number, height: number) {
			calls.push({ kind: "fillRect", x, y, width, height, originX: this.originX });
		},
		roundRect(x: number, y: number, width: number, height: number) {
			calls.push({ kind: "roundRect", x, y, width, height });
		},
		beginPath() {},
		fill() {},
	});
	return { ctx, calls };
}

function metrics(width: number): TextMetrics {
	return Object.assign(Object.create(null), {
		width,
		actualBoundingBoxAscent: 16,
		actualBoundingBoxDescent: 4,
	});
}

const LINE_HEIGHT = 24;

function buildLayout({
	lines,
	textAlign,
	textDecoration = "none",
}: {
	lines: string[];
	textAlign: TextAlign;
	textDecoration?: TextDecoration;
}): MeasuredTextLayout {
	return {
		scaledFontSize: 20,
		fontString: "20px Test",
		letterSpacing: 0,
		lineHeightPx: LINE_HEIGHT,
		fontSizeRatio: 1,
		textAlign,
		textDecoration,
		lines,
		lineMetrics: lines.map((line) => metrics(line.length * 10)),
		block: {
			visualCenterOffset: ((lines.length - 1) * LINE_HEIGHT) / 2,
			height: lines.length * LINE_HEIGHT,
			maxWidth: Math.max(...lines.map((line) => line.length * 10)),
		},
	};
}

function draw({
	layout,
	visibleLengths,
	withBackground = false,
}: {
	layout: MeasuredTextLayout;
	visibleLengths?: number[];
	withBackground?: boolean;
}) {
	const { ctx, calls } = createRecordingContext();
	drawMeasuredTextLayout({
		ctx,
		layout,
		textColor: "#fff",
		visibleLengths,
		...(withBackground && {
			background: {
				enabled: true,
				color: "#000",
				paddingX: 5,
				paddingY: 5,
				offsetX: 0,
				offsetY: 0,
				cornerRadius: 0,
			},
			backgroundColor: "#000",
		}),
	});
	return { ctx, calls };
}

function textCalls(calls: DrawCall[]) {
	return calls.filter((call) => call.kind === "fillText");
}

function rectCalls(calls: DrawCall[]) {
	return calls.filter((call) => call.kind === "fillRect");
}

describe("drawing a text reveal", () => {
	test("a centered line keeps its place: prefix drawn from the full line's left edge", () => {
		const layout = buildLayout({ lines: ["abcdef"], textAlign: "center" });
		const { calls } = draw({ layout, visibleLengths: [3] });

		// Full line is 60 px wide, so it starts at -30.
		expect(textCalls(calls)).toEqual([
			{ kind: "fillText", text: "abc", x: 0, y: 0, textAlign: "left", originX: -30 },
		]);
	});

	test("the underline covers the visible part only, starting where the full line starts", () => {
		const layout = buildLayout({
			lines: ["abcdef"],
			textAlign: "center",
			textDecoration: "underline",
		});
		const { calls } = draw({ layout, visibleLengths: [3] });
		const [underline] = rectCalls(calls);

		expect(rectCalls(calls)).toHaveLength(1);
		// "abc" is 30 px wide (not the 60 px of the full line), left edge at -30.
		expect(underline.width).toBe(30);
		expect(underline.originX + underline.x).toBe(-30);
	});

	test("left and right alignment offset the line by 0 and by its full width", () => {
		const left = draw({
			layout: buildLayout({ lines: ["abcdef"], textAlign: "left" }),
			visibleLengths: [2],
		});
		const right = draw({
			layout: buildLayout({ lines: ["abcdef"], textAlign: "right" }),
			visibleLengths: [2],
		});

		expect(textCalls(left.calls)).toEqual([
			{ kind: "fillText", text: "ab", x: 0, y: 0, textAlign: "left", originX: 0 },
		]);
		expect(textCalls(right.calls)).toEqual([
			{ kind: "fillText", text: "ab", x: 0, y: 0, textAlign: "left", originX: -60 },
		]);
	});

	test("every line is aligned by its own full width", () => {
		const layout = buildLayout({ lines: ["ab", "cdefg"], textAlign: "center" });
		const { calls } = draw({ layout, visibleLengths: [2, 3] });

		expect(textCalls(calls)).toEqual([
			{ kind: "fillText", text: "ab", x: 0, y: -12, textAlign: "left", originX: -10 },
			{ kind: "fillText", text: "cde", x: 0, y: 12, textAlign: "left", originX: -25 },
		]);
	});

	test("a line with 0 visible units draws nothing, not even its underline", () => {
		const layout = buildLayout({
			lines: ["abcdef"],
			textAlign: "center",
			textDecoration: "underline",
		});
		const { calls } = draw({ layout, visibleLengths: [0] });

		expect(calls).toEqual([]);
	});

	test("the canvas state is restored afterwards", () => {
		const layout = buildLayout({ lines: ["abcdef"], textAlign: "center" });
		const { ctx } = draw({ layout, visibleLengths: [3] });

		expect(ctx.textAlign).toBe("center");
		expect(Reflect.get(ctx, "originX")).toBe(0);
	});

	test("the background box stays at full size while the text is revealed", () => {
		const layout = buildLayout({ lines: ["abcdef"], textAlign: "center" });
		const revealing = draw({ layout, visibleLengths: [1], withBackground: true });
		const full = draw({ layout, withBackground: true });

		const boxes = (calls: DrawCall[]) => calls.filter((call) => call.kind === "roundRect");
		expect(boxes(revealing.calls)).toHaveLength(1);
		expect(boxes(revealing.calls)).toEqual(boxes(full.calls));
	});
});

describe("drawing without a reveal", () => {
	test("draws the whole line with the layout's own alignment, exactly as before", () => {
		const layout = buildLayout({
			lines: ["abcdef"],
			textAlign: "center",
			textDecoration: "underline",
		});
		const { calls } = draw({ layout });

		expect(textCalls(calls)).toEqual([
			{ kind: "fillText", text: "abcdef", x: 0, y: 0, textAlign: "center", originX: 0 },
		]);
		const [underline] = rectCalls(calls);
		expect(underline.x).toBe(-30);
		expect(underline.width).toBe(60);
		expect(underline.originX).toBe(0);
	});

	test("a fully revealed line lands on the same pixels as the plain path", () => {
		for (const textAlign of ["left", "center", "right"] as const) {
			const layout = buildLayout({
				lines: ["abcdef"],
				textAlign,
				textDecoration: "underline",
			});
			const plain = draw({ layout });
			const revealed = draw({ layout, visibleLengths: [6] });

			const [plainText] = textCalls(plain.calls);
			const [revealedText] = textCalls(revealed.calls);
			expect(plainText.kind === "fillText" && revealedText.kind === "fillText").toBe(true);
			if (plainText.kind !== "fillText" || revealedText.kind !== "fillText") return;
			expect(revealedText.text).toBe(plainText.text);
			// Left edge of the text on the canvas, whichever way it was aligned.
			const plainLeft =
				plainText.originX +
				plainText.x +
				(textAlign === "center" ? -30 : textAlign === "right" ? -60 : 0);
			expect(revealedText.originX + revealedText.x).toBe(plainLeft);

			const [plainRule] = rectCalls(plain.calls);
			const [revealedRule] = rectCalls(revealed.calls);
			expect(revealedRule.width).toBe(plainRule.width);
			expect(revealedRule.originX + revealedRule.x).toBe(plainRule.originX + plainRule.x);
		}
	});
});
