import { describeId } from "./describe-id";

export function parseStickerId({ stickerId }: { stickerId: string }): {
	providerId: string;
	providerValue: string;
} {
	const normalizedStickerId = stickerId.trim();
	if (!normalizedStickerId) {
		throw new Error("Sticker ID must be a non-empty string");
	}
	if (normalizedStickerId !== stickerId) {
		throw new Error(`Sticker ID must not have surrounding whitespace: "${describeId({ value: stickerId })}"`);
	}

	const separatorIndex = normalizedStickerId.indexOf(":");
	if (
		separatorIndex <= 0 ||
		separatorIndex === normalizedStickerId.length - 1
	) {
		throw new Error(
			`Invalid sticker ID format: "${describeId({ value: stickerId })}". Expected "provider:value".`,
		);
	}

	const providerId = normalizedStickerId.slice(0, separatorIndex);
	const providerValue = normalizedStickerId.slice(separatorIndex + 1);
	if (providerId !== providerId.trim() || providerValue !== providerValue.trim()) {
		throw new Error(
			`Sticker ID must not have whitespace around its parts: "${describeId({ value: stickerId })}"`,
		);
	}

	return { providerId, providerValue };
}

export function buildStickerId({
	providerId,
	providerValue,
}: {
	providerId: string;
	providerValue: string;
}): string {
	return `${providerId}:${providerValue}`;
}
