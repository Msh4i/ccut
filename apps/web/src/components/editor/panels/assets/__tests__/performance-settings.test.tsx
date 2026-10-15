import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PerformanceModeView } from "../views/settings/performance";

const noop = () => {};

describe("the Performance setting (static markup)", () => {
	test("offers Balanced and High, marks the current one, and says it applies to every project", () => {
		const markup = renderToStaticMarkup(<PerformanceModeView mode="high" onSelect={noop} />);
		expect(markup).toContain("Performance");
		expect(markup).toContain("Balanced");
		expect(markup).toContain("High");
		expect(markup).toContain("every project");
		const pressed = [...markup.matchAll(/aria-pressed="(true|false)"[^>]*>(?:<[^>]+>)*([A-Za-z]+)/g)].map(
			(match) => [match[2], match[1]],
		);
		expect(pressed).toEqual([
			["Balanced", "false"],
			["High", "true"],
		]);
	});

	test("balanced selected", () => {
		const markup = renderToStaticMarkup(<PerformanceModeView mode="balanced" onSelect={noop} />);
		expect(markup.match(/aria-pressed="true"/g)?.length).toBe(1);
		expect(markup.indexOf('aria-pressed="true"')).toBeLessThan(markup.indexOf("High"));
	});
});
