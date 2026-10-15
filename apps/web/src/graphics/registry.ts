import { DefinitionRegistry } from "@/params/registry";
import type { GraphicDefinition } from "./types";

export class GraphicsRegistry extends DefinitionRegistry<string, GraphicDefinition> {
	private readonly unlisted = new Set<string>();

	constructor() {
		super("graphic");
	}

	/**
	 * Registers a definition that renders and resolves like any other but is
	 * not listed by {@link getAll} (the 3D null of Track Camera).
	 */
	registerUnlisted({
		key,
		definition,
	}: {
		key: string;
		definition: GraphicDefinition;
	}): void {
		this.register({ key, definition });
		this.unlisted.add(key);
	}

	/** The definitions the user can pick from (the shapes library): unlisted ones are left out. */
	override getAll(): GraphicDefinition[] {
		return super.getAll().filter((definition) => !this.unlisted.has(definition.id));
	}
}

export const graphicsRegistry = new GraphicsRegistry();
