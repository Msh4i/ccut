import type { EffectPass, EffectUniformValue } from "./types";

function isFiniteUniform(value: EffectUniformValue): boolean {
	return Array.isArray(value)
		? value.every((number) => Number.isFinite(number))
		: Number.isFinite(value);
}

/** Says each message once per key, and at most `max` keys: a repeated problem warns, it does not flood. */
export class OnceWarner {
	private readonly max: number;
	private said = new Set<string>();

	constructor({ max = 32 }: { max?: number } = {}) {
		this.max = max;
	}

	/** True when the warning was written now. */
	warnOnce({ key, message }: { key: string; message: string }): boolean {
		if (this.said.has(key) || this.said.size >= this.max) return false;
		this.said.add(key);
		console.warn(message);
		return true;
	}
}

const leftOutWarnings = new OnceWarner();

function isUsableGroup(group: EffectPass[]): boolean {
	if (group.length === 0) return false;
	for (const pass of group) {
		const broken = Object.entries(pass.uniforms).find(
			([, value]) => !isFiniteUniform(value),
		);
		if (broken) {
			// A future effect with a bug in its uniforms must not vanish from the
			// preview and from exports without a trace.
			const [uniform] = broken;
			leftOutWarnings.warnOnce({
				key: `${pass.shader}:${uniform}`,
				message: `Effect shader "${pass.shader}" left out: its uniform "${uniform}" is not a finite number. Frames are drawn and exported without it.`,
			});
			return false;
		}
	}
	return true;
}

/**
 * The effect pass groups (one per effect) a layer may hand to the compositor.
 *
 * An effect with nothing to do (a blur of 0 px, a clip scaled to 0) builds no
 * passes. The compositor took such an empty group as an error and failed the
 * whole frame, so the preview kept its last picture. A pass with a uniform that
 * is not a finite number would turn the layer into NaN pixels. Both are left
 * out here: the layer is drawn without that effect (the second with a console
 * warning, once per shader and uniform).
 */
export function usablePassGroups(groups: EffectPass[][]): EffectPass[][] {
	// Each group is checked once; no copy when all of them are usable.
	let usable: EffectPass[][] | null = null;
	for (let index = 0; index < groups.length; index++) {
		const group = groups[index];
		if (!isUsableGroup(group)) {
			usable ??= groups.slice(0, index);
		} else if (usable) {
			usable.push(group);
		}
	}
	return usable ?? groups;
}
