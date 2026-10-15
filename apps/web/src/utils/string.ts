export function capitalizeFirstLetter({ string }: { string: string }) {
	return string.charAt(0).toUpperCase() + string.slice(1);
}

export function uppercase({ string }: { string: string }) {
	return string.toUpperCase();
}

const MAX_FILE_LABEL_LENGTH = 15;
const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,5}$/i;

/** Shortens a long file name to "head….ext": the extension appears once. */
export function truncateFileName({ name }: { name: string }) {
	if ([...name].length <= MAX_FILE_LABEL_LENGTH) return name;
	const extension = FILE_EXTENSION_PATTERN.exec(name)?.[0] ?? "";
	const head = [...name.slice(0, name.length - extension.length)]
		.slice(0, MAX_FILE_LABEL_LENGTH - 1 - extension.length)
		.join("");
	return `${head}…${extension}`;
}
