import { SMART_CUTOUT_MODEL } from "./constants";
import type { OrtRequest, OrtResponse } from "./ort-worker";

export interface OrtClient {
	infer({ tensor }: { tensor: Float32Array }): Promise<Float32Array>;
	dispose(): void;
}

/** Starts the worker and loads the model into it. Rejects with a short message. */
export async function createOrtClient({ model }: { model: Uint8Array }): Promise<OrtClient> {
	const worker = new Worker(new URL("./ort-worker.ts", import.meta.url), { type: "module" });
	let next = 1;
	const waiting = new Map<number, { resolve(value: OrtResponse): void; reject(error: Error): void }>();
	const failAll = (message: string) => {
		for (const entry of waiting.values()) entry.reject(new Error(message));
		waiting.clear();
	};
	worker.onmessage = (event: MessageEvent<OrtResponse>) => {
		const entry = waiting.get(event.data.id);
		if (!entry) return;
		waiting.delete(event.data.id);
		if (event.data.type === "error") entry.reject(new Error(event.data.message));
		else entry.resolve(event.data);
	};
	worker.onerror = () => failAll("The cutout worker stopped.");
	const send = ({ request, transfer = [] }: { request: Extract<OrtRequest, { id: number }>; transfer?: Transferable[] }) =>
		new Promise<OrtResponse>((resolve, reject) => {
			waiting.set(request.id, { resolve, reject });
			worker.postMessage(request, transfer);
		});
	// Threads need cross-origin isolation (SharedArrayBuffer); without it the runtime uses one.
	const threads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1)) : 1;
	try {
		await send({ request: { type: "init", id: next++, model, wasmBase: `${location.origin}/ort/`, threads } });
	} catch (error) {
		worker.terminate();
		throw error;
	}
	const size = SMART_CUTOUT_MODEL.inputSize;
	return {
		async infer({ tensor }) {
			const answer = await send({ request: { type: "infer", id: next++, tensor, size }, transfer: [tensor.buffer] });
			if (answer.type !== "result") throw new Error("unexpected answer");
			return answer.output;
		},
		dispose() {
			failAll("The cutout was stopped.");
			worker.postMessage({ type: "dispose" } satisfies OrtRequest);
			worker.terminate();
		},
	};
}
