/**
 * Prints the multi-clip tables of the frame cache simulation.
 *
 *   bun apps/web/src/services/video-cache/sim/run-timeline-sim.ts
 *   bun apps/web/src/services/video-cache/sim/run-timeline-sim.ts --same-file
 *
 * The first prints the scenarios of docs/ccut/playback-streams-report.md, then
 * the sweep of 1..12 clips of one file (every shape x every variant);
 * `--same-file` prints only the sweep.
 * All timings are assumptions (see `timeline-scenarios.ts`), not measurements.
 */
import {
	SAME_FILE_MAX_CLIPS,
	SAME_FILE_SHAPES,
	SAME_FILE_VARIANTS,
	TIMELINE_SCENARIOS,
	UPLOAD_SCENARIOS,
	sameFileScenario,
} from "./timeline-scenarios";
import {
	SAME_FILE_RESULT_HEADER,
	TIMELINE_RESULT_HEADER,
	type TimelineVariant,
	formatSameFileRow,
	formatTimelineRow,
	runTimelineScenario,
} from "./timeline-sim";

/**
 * "one stream per media" reproduces the cache before streams (the rows of
 * contract head a2eb781 are in docs/ccut/playback-streams-report.md).
 */
const VARIANTS: TimelineVariant[] = [
	{ label: "one stream per media", keyed: false, streams: { maxPerMedia: 1 } },
	{ label: "streams, no key", keyed: false },
	{ label: "streams, element id key", keyed: true },
];

async function printScenarios() {
	console.log(TIMELINE_RESULT_HEADER);
	for (const scenario of [...TIMELINE_SCENARIOS, ...UPLOAD_SCENARIOS]) {
		for (const variant of VARIANTS) {
			const result = await runTimelineScenario({ scenario, variant });
			console.log(formatTimelineRow({ scenario, result }));
		}
	}
}

/** 1..12 clips of one file, every shape and variant; one scenario per clip count. */
async function printSameFileSweep() {
	console.log(SAME_FILE_RESULT_HEADER);
	for (const { label, ...shape } of SAME_FILE_SHAPES) {
		for (const variant of SAME_FILE_VARIANTS) {
			for (let clips = 1; clips <= SAME_FILE_MAX_CLIPS; clips++) {
				const result = await runTimelineScenario({
					scenario: sameFileScenario({ count: clips, ...shape }),
					variant,
				});
				console.log(formatSameFileRow({ shape: label, clips, result }));
			}
		}
	}
}

async function main() {
	if (!process.argv.includes("--same-file")) {
		await printScenarios();
		console.log("");
	}
	await printSameFileSweep();
}

await main();
