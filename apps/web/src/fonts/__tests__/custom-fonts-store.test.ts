import { describe, expect, it } from "bun:test";
import { groupCustomFamilies } from "../custom-fonts-store";

function entry({
	family,
	failed,
	weight = 400,
}: {
	family: string;
	failed?: boolean;
	weight?: number;
}) {
	return {
		id: `${family}-${weight}`,
		family,
		weight,
		style: "normal" as const,
		format: "ttf" as const,
		fileName: "f.ttf",
		size: 1,
		addedAt: 1,
		...(failed ? { failed } : {}),
	};
}

describe("groupCustomFamilies", () => {
	it("lists each family once, sorted", () => {
		const { families } = groupCustomFamilies({
			fonts: [
				entry({ family: "Zed" }),
				entry({ family: "Alpha", weight: 400 }),
				entry({ family: "Alpha", weight: 700 }),
			],
		});
		expect(families).toEqual(["Alpha", "Zed"]);
	});

	it("marks a family failed only when none of its styles registered", () => {
		const { failed } = groupCustomFamilies({
			fonts: [
				entry({ family: "AllBad", failed: true, weight: 400 }),
				entry({ family: "AllBad", failed: true, weight: 700 }),
				entry({ family: "Half", failed: true, weight: 400 }),
				entry({ family: "Half", weight: 700 }),
				entry({ family: "Fine" }),
			],
		});
		expect([...failed]).toEqual(["AllBad"]);
	});

	it("handles an empty library", () => {
		expect(groupCustomFamilies({ fonts: [] })).toEqual({
			families: [],
			failed: new Set(),
		});
	});
});
