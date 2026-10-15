export type ExitAnswer = "leave" | "stay";
export type ExitStep = "exit" | "ask" | "stay";

/**
 * What "Exit project" does next. `saved` is whether the final save worked;
 * `answer` is the user's reply to the "unsaved changes" question, or null if
 * they have not been asked yet. Only an explicit "leave" may drop unsaved work.
 */
export function decideExit({
	saved,
	answer,
}: {
	saved: boolean;
	answer: ExitAnswer | null;
}): ExitStep {
	if (saved) return "exit";
	if (answer === "leave") return "exit";
	if (answer === "stay") return "stay";
	return "ask";
}
