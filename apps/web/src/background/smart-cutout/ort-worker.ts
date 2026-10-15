import * as ort from "onnxruntime-web/wasm";

/**
 * Runs the cutout model off the UI thread. The page sends the verified model bytes once, then one
 * float32 tensor per frame; it gets the first output back. The wasm runtime is loaded from the
 * app itself (public/ort, copied by scripts/copy-ort-wasm.mjs).
 */
export type OrtRequest =
	| { type: "init"; id: number; model: Uint8Array; wasmBase: string; threads: number }
	| { type: "infer"; id: number; tensor: Float32Array; size: number }
	| { type: "dispose" };

export type OrtResponse =
	| { type: "ready"; id: number }
	| { type: "result"; id: number; output: Float32Array }
	| { type: "error"; id: number; message: string };

let session: ort.InferenceSession | null = null;

self.onmessage = async (event: MessageEvent<OrtRequest>) => {
	const message = event.data;
	if (message.type === "dispose") {
		await session?.release().catch(() => {});
		session = null;
		return;
	}
	try {
		if (message.type === "init") {
			ort.env.wasm.wasmPaths = message.wasmBase;
			ort.env.wasm.numThreads = message.threads;
			ort.env.wasm.proxy = false;
			session = await ort.InferenceSession.create(message.model, { executionProviders: ["wasm"] });
			self.postMessage({ type: "ready", id: message.id } satisfies OrtResponse);
			return;
		}
		if (!session) throw new Error("model not loaded");
		const input = session.inputNames[0];
		const outputName = session.outputNames[0];
		if (!input || !outputName) throw new Error("model has no input or output");
		const result = await session.run({
			[input]: new ort.Tensor("float32", message.tensor, [1, 3, message.size, message.size]),
		});
		const data = result[outputName]?.data;
		if (!(data instanceof Float32Array)) throw new Error("unexpected model output");
		const output = new Float32Array(data);
		self.postMessage({ type: "result", id: message.id, output } satisfies OrtResponse, [output.buffer]);
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		self.postMessage({ type: "error", id: message.id, message: text.slice(0, 200) } satisfies OrtResponse);
	}
};
