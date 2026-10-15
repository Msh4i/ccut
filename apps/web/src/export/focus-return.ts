/**
 * The `onCloseAutoFocus` of a dialog that has no trigger of its own (the Export
 * button opens the export window by state, not through a `DialogTrigger`): the
 * default would focus the missing trigger, so the dialog's shared wrapper
 * cancels it and focus fell to the page. This one cancels it too and puts focus
 * on `target()`, so a keyboard user lands back on the button they pressed.
 */
export function createCloseAutoFocusHandler({
	target,
}: {
	target: () => { focus: () => void } | null;
}): (event: Event) => void {
	return (event) => {
		event.preventDefault();
		target()?.focus();
	};
}
