import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";

/**
 * A command that replaces the active scene's tracks with `apply(tracks)`
 * and keeps the tracks it replaced for undo. `apply` is pure and throws,
 * before anything is written, when the edit cannot be made; a redo runs it
 * again on the restored tracks and gets the same result.
 */
export abstract class TracksChangeCommand extends Command {
	private savedState: SceneTracks | null = null;

	protected abstract apply(tracks: SceneTracks): SceneTracks;

	/** Selection after the edit (none by default). */
	protected selectionAfter(): CommandResult | undefined {
		return undefined;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const tracks = editor.scenes.getActiveScene().tracks;
		const next = this.apply(tracks);
		this.savedState = tracks;
		editor.timeline.updateTracks(next);
		return this.selectionAfter();
	}

	undo(): void {
		if (!this.savedState) return;
		EditorCore.getInstance().timeline.updateTracks(this.savedState);
	}
}
