// onnxruntime-web ships types.d.ts but its package.json "exports" do not point to them, so the
// bundler-resolution compiler sees `any`. Only what the smart cutout uses is declared.
interface OrtTensor {
	readonly data: Float32Array | Uint8Array | Int32Array;
	readonly dims: readonly number[];
}
interface OrtInferenceSession {
	readonly inputNames: readonly string[];
	readonly outputNames: readonly string[];
	run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
	release(): Promise<void>;
}
interface OrtModule {
	env: { wasm: { numThreads: number; wasmPaths: string; proxy: boolean } };
	Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => OrtTensor;
	InferenceSession: {
		create(
			model: Uint8Array,
			options: { executionProviders: readonly string[]; graphOptimizationLevel?: "all" | "basic" | "disabled" },
		): Promise<OrtInferenceSession>;
	};
}
declare module "onnxruntime-web" {
	export const env: OrtModule["env"];
	export const Tensor: OrtModule["Tensor"];
	export const InferenceSession: OrtModule["InferenceSession"];
	export type InferenceSession = OrtInferenceSession;
}
declare module "onnxruntime-web/wasm" {
	export const env: OrtModule["env"];
	export const Tensor: OrtModule["Tensor"];
	export const InferenceSession: OrtModule["InferenceSession"];
	export type InferenceSession = OrtInferenceSession;
}
