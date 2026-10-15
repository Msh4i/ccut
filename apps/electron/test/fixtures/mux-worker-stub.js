// A stand-in for link-import-mux-worker.js in the runner tests: it misbehaves on purpose, as
// told by workerData.job.stub, so the main-process side (link-import-mux.js) can be checked.
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

const mode = workerData && workerData.job ? workerData.job.stub : "none";
const post = (message) => parentPort.postMessage(message);

switch (mode) {
	case "hang":
		// starts, then never answers and ignores "cancel"
		post({ type: "progress", fraction: 0 });
		setInterval(() => {}, 1000);
		break;
	case "obey":
		// answers a cancel request like the real worker does
		post({ type: "progress", fraction: 0.25 });
		parentPort.on("message", (message) => {
			if (message && message.type === "cancel") post({ type: "error", code: "cancelled" });
		});
		break;
	case "silent":
		// alive, but no progress at all
		setInterval(() => {}, 1000);
		break;
	case "slow":
		// progress keeps coming, it just never ends
		setInterval(() => post({ type: "progress", fraction: 0.5 }), 20);
		break;
	case "crash":
		throw new Error("stub crash /home/owner/secret");
	case "exit":
		process.exit(3);
		break;
	case "garbage":
		post("not an object");
		post({ type: "progress", fraction: Number.NaN });
		post({ type: "progress", fraction: 7 });
		post({ type: "done", result: { packets: 5, shift: 0, width: 2, height: 2, duration: 1 } });
		break;
	case "late-done":
		// answers a cancel (or nothing at all) with a valid "done"
		post({ type: "progress", fraction: 0.5 });
		parentPort.on("message", (message) => {
			if (message && message.type === "cancel") post({ type: "done", result: { packets: 5, shift: 0, width: 2, height: 2, duration: 1 } });
		});
		break;
	case "bad-done":
		post({ type: "done", result: { packets: -1, shift: "x" } });
		break;
	default:
		post({ type: "error", code: "bad-output" });
}
