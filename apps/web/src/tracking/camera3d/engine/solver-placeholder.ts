import type { SolveCamera } from "../types";

export const SOLVER_UNAVAILABLE_MESSAGE = "The camera solver is not part of this build yet.";

/**
 * Stands in for workstream A's `solveCamera` until the integration wires it
 * (editor-provider.tsx passes the solver to the engine). Fails every solve
 * with a clear message, so nothing is written.
 */
export const solverUnavailable: SolveCamera = async () => ({
	status: "failed",
	reason: "diverged",
	message: SOLVER_UNAVAILABLE_MESSAGE,
});
