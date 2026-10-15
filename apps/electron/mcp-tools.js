// MCP server (round 8): the tools the app offers to an agent. Each is a name, a description, the
// access it needs ("read" or "edit") and its input as a zod shape; the work itself is done by the
// editor in the page (the bridge). A tool never runs a shell, never touches a path and never
// reaches the network: it names things the project already has (an asset id, an element id).
// Every edit tool is ONE undo step in the editor (it goes through the editor's commands).

const PRESET_IDS = [
	"zoom-in",
	"zoom-out",
	"pulse",
	"shake",
	"float",
	"swing",
	"pan-left",
	"pan-right",
	"pan-up",
	"pan-down",
	"volume-fade-in",
	"volume-fade-out",
	"volume-duck",
	"volume-swell",
];

const MAX_ID_CHARS = 128;
const MAX_TEXT_CHARS = 5000;
const MAX_SECONDS = 24 * 3600;

/** The tool list for a zod `z`. `result: "image"` tools answer { base64 } and are returned as an image. */
function buildTools(z) {
	const id = z.string().min(1).max(MAX_ID_CHARS);
	const seconds = z.number().finite().min(0).max(MAX_SECONDS);
	return [
		{ name: "get_project", access: "read", description: "The open project: name, canvas size, frame rate and length in seconds.", input: {} },
		{ name: "list_tracks", access: "read", description: "The tracks of the project, in order, with their kind and how many elements each has.", input: {} },
		{
			name: "list_elements",
			access: "read",
			description: "The clips on the timeline (id, track, type, start, duration, name). Pass trackId to list one track.",
			input: { trackId: id.optional() },
		},
		{ name: "list_assets", access: "read", description: "The media in the project's library (id, name, kind, duration).", input: {} },
		{ name: "get_playhead", access: "read", description: "The playhead position in seconds and whether the project is playing.", input: {} },
		{ name: "get_selection", access: "read", description: "The ids of the selected clips.", input: {} },
		{
			name: "get_preview_frame",
			access: "read",
			description: "A PNG of the frame under the playhead (at most maxWidth px wide, 640 by default).",
			input: { maxWidth: z.number().int().min(64).max(1280).optional() },
			result: "image",
		},
		{
			name: "add_asset_to_timeline",
			access: "edit",
			description: "Puts a library asset on the timeline at startSeconds (the playhead by default), on trackId or a fitting track.",
			input: { assetId: id, startSeconds: seconds.optional(), trackId: id.optional() },
		},
		{
			name: "split_at",
			access: "edit",
			description: "Cuts at a time on the timeline: the selected clips, or the clip elementId, or every clip under that time.",
			input: { seconds, elementId: id.optional() },
		},
		{ name: "delete_element", access: "edit", description: "Deletes a clip.", input: { elementId: id } },
		{
			name: "move_element",
			access: "edit",
			description: "Moves a clip to startSeconds on the timeline, optionally to another track.",
			input: { elementId: id, startSeconds: seconds, trackId: id.optional() },
		},
		{
			name: "set_property",
			access: "edit",
			description: "Sets a property of a clip (for example opacity, transform.positionX, volume, fontSize) to a fixed value.",
			input: { elementId: id, property: z.string().min(1).max(MAX_ID_CHARS), value: z.union([z.number().finite(), z.string().max(MAX_TEXT_CHARS), z.boolean()]) },
		},
		{
			name: "add_keyframe",
			access: "edit",
			description: "Adds a keyframe of a property at a time inside the clip (seconds from the clip's start).",
			input: { elementId: id, property: z.string().min(1).max(MAX_ID_CHARS), seconds, value: z.union([z.number().finite(), z.string().max(MAX_TEXT_CHARS), z.boolean()]) },
		},
		{
			name: "apply_keyframe_preset",
			access: "edit",
			description: "Writes a ready-made keyframe animation (zoom, pulse, shake, pan, volume fade ...) on a clip.",
			input: {
				elementId: id,
				presetId: z.enum(PRESET_IDS),
				placement: z.enum(["start", "playhead", "end"]).optional(),
				seconds: z.number().finite().min(0.1).max(600).optional(),
			},
		},
		{ name: "set_text", access: "edit", description: "Replaces the text of a text clip.", input: { elementId: id, text: z.string().max(MAX_TEXT_CHARS) } },
		{ name: "seek", access: "edit", description: "Moves the playhead to a time in seconds.", input: { seconds } },
		{ name: "play", access: "edit", description: "Starts playback.", input: {} },
		{ name: "pause", access: "edit", description: "Stops playback.", input: {} },
	];
}

module.exports = { PRESET_IDS, buildTools };
