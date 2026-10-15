# Keyframe System

Keyframes allow element properties to change over time. The system is split into three layers: the **data model** (how keyframes are stored), the **registry** (which properties support keyframes and how to read/write them), and the **UI** (hooks and components that wire it all together).

> **Where things live.** The keyframe code is in `src/animation/*`, the closed list of fixed animatable paths is `ANIMATION_PROPERTY_PATHS` in `src/animation/types.ts`, and the params of each element type (defaults, ranges, sliders) are in `src/params/registry.ts`.

## How It Works

### Data model

Every `BaseTimelineElement` has an optional `animations?: ElementAnimations` field:

```typescript
interface ElementAnimations {
    [propertyPath: string]: ChannelData | undefined;
}
```

Each entry is keyed by property path (e.g. `"opacity"`, `"transform.positionX"`, `"background.color"`) and holds a channel, a list of `keys`. A `ScalarChannel` has numeric keys with a segment type (`step`, `linear`, `bezier`) and tangent handles. A `DiscreteChannel` has boolean or string keys that hold their value. A color is a composite: one scalar channel per component (`r`, `g`, `b`, `a`). The types are in `src/animation/types.ts`.

### Registry

`src/params/registry.ts` defines the params of every element type and their defaults and ranges (`elementParamRegistry`). `src/timeline/animation-targets.ts` (`resolveAnimationTarget`) turns a property path into its channel layout, value coercion and base value for an element. `ANIMATION_PROPERTY_PATHS` in `src/animation/types.ts` is the list of fixed paths (transform, opacity, volume, colors, text background); graphic and effect params use `params.<key>` and `effects.<id>.params.<key>` paths. Channels are written with `src/animation/keyframes.ts` (`upsertPathKeyframe`, `setChannel`, ...).

### Resolver

`src/animation/resolve.ts` (`resolveAnimationPathValueAtTime`) returns the effective value of a property at a given local time, falling back to the element's static value when no keyframes exist. Interpolation is in `src/animation/interpolation.ts`; `src/animation/values.ts` and `src/rendering/animation-values.ts` wrap it for numbers, colors, opacity and the transform.

### Renderer

Nodes in `src/services/renderer/` call the resolve functions before drawing so that animated properties interpolate correctly during export and preview.

### UI

`useKeyframedParamProperty` in `src/components/editor/panels/properties/hooks/use-keyframed-param-property.ts` handles the keyframe-aware field logic for a param. It handles the toggle/add/remove keyframe flow and automatically switches between writing to the static property and writing to the animation channel depending on whether keyframes are active.

## Preset animations vs keyframes

In/Out preset animations (the Animation tab) are **not** keyframes. They are a separate, optional field on video, image, text, sticker and graphic elements:

```typescript
presetAnimations?: {
    in?: { id: PresetAnimationId; duration: MediaTime };
    out?: { id: PresetAnimationId; duration: MediaTime };
};
```

No channels are written, nothing appears on the timeline, and the user's own keyframes or fixed values are never modified. A preset is evaluated at resolve time as a delta laid over the user's values, always in this order: user keyframes, then the preset. Opacity and scale are multiplied, position is added (canvas pixels).

- **One code path.** `resolvePresetState` in `src/services/renderer/resolve.ts` applies the delta for both preview and export, so they cannot disagree.
- **Pure logic** lives in `src/animation/presets/` (`definitions.ts` is the registry, `resolve.ts` the maths) and is tested in `src/animation/__tests__/presets.test.ts`. To add a preset, add one entry to `PRESET_DEFINITIONS`; the mirror test then covers it automatically.
- **Out is In played backwards** with the same easing, so a slide "from left" in has a slide "to left" out.
- **Durations.** The requested duration is stored. At resolve time, if In + Out do not fit in the clip they are scaled down by the same factor so they exactly fill it. The stored values are untouched, so lengthening the clip brings them back. The panel shows the squeezed lengths, and editing either phase writes the other phase at its shown length (`setPresetPhase`), so editing one box never moves the other.
- **Splitting a clip** keeps In on the left half and Out on the right half (`splitPresetAnimations`). Splitting inside an In window does not cut the animation: the left half's In is squeezed (rescaled) to the shorter clip and still ends at rest, so there is no jump at the cut.
- **Text reveal** presets (`typewriter`, `word-reveal`) do not move anything. `src/text/reveal.ts` turns the visible fraction into a prefix length per line; the layout and background box stay at full size.
- **No migration.** The field is optional and an unknown preset id is ignored, so older and newer projects load either way.
- **Handles.** The preview transform handles and the text edit overlay use the user's own geometry and do not follow a running preset.

---

## Adding a New Animatable Property

Using `"background.paddingX"` as an example.

### 1. Register the path — `src/animation/types.ts`

```typescript
export const ANIMATION_PROPERTY_PATHS = [
    // ...existing paths
    "background.paddingX",
] as const;
```

### 2. Declare the param — `src/params/registry.ts`

Add it to the element type's param list (here `textElementParams`; text params also get their default in `src/timeline/defaults.ts`):

```typescript
{
    key: "background.paddingX",
    label: "Background Padding X",
    type: "number",               // "number" | "boolean" | "color" | "select" | "text" | "font"
    default: DEFAULTS.text.background.paddingX,
    min: 0,
    step: 1,
    slider: { min: 0, max: 200 },
    dependencies: [{ param: "background.enabled", equals: true }],
},
```

**Notes:**
- A param is keyframable unless it sets `keyframable: false`. `resolveAnimationTarget` (`src/timeline/animation-targets.ts`) builds its channel layout and value coercion (min, max, step) from this definition, so no second registry entry is needed.
- Values live in `element.params[key]` by default. Give the param `read` / `write` only when its value is stored somewhere else on the element.
- `readElementParamValue` returns the effective base value including the default; that is what gets recorded when a keyframe is added.

### 3. Resolve it where it is used — `src/animation/values.ts`

For **numbers**, use `resolveNumberAtTime`:

```typescript
import { resolveNumberAtTime } from "@/animation/values";

const resolvedPaddingX = resolveNumberAtTime({
    baseValue: bg.paddingX ?? DEFAULTS.text.background.paddingX,
    animations: element.animations,
    propertyPath: "background.paddingX",
    localTime,
});
```

For **colors**, use `resolveColorAtTime`:

```typescript
const resolvedColor = resolveColorAtTime({
    baseColor: element.color,
    animations: element.animations,
    propertyPath: "color",
    localTime,
});
```

If neither fits (new value kind), call `resolveAnimationPathValueAtTime` from `src/animation/resolve.ts` directly, as `resolveOpacityAtTime` does.

### 4. Wire the renderer

In the relevant node (`src/services/renderer/nodes/`) or in the code that measures and lays out the element, call the resolve function before drawing and use the resolved value (not `params.*`) wherever that value affects rendering. Preview and export share this code, so they stay identical.

### 5. Wire the UI

In the properties panel, replace `usePropertyDraft` with the appropriate keyframe hook and add a `KeyframeToggle` to the field.

**For number fields**, declare the param in `params/registry.ts` (or the definition's `params`) and render it with `PropertyParamField`, wired through `useKeyframedParamProperty` (see `components/editor/panels/properties/components/element-params-tab.tsx`):

```tsx
const animated = useKeyframedParamProperty({
    param,
    trackId,
    elementId: element.id,
    animations: element.animations,
    propertyPath: param.key,
    localTime,
    isPlayheadWithinElementRange,
    resolvedValue,
    buildBaseUpdates: ({ value }) => writeElementParamValue({ element, param, value }),
});

<PropertyParamField
    param={param}
    value={resolvedValue}
    onPreview={animated.onPreview}
    onCommit={animated.onCommit}
    keyframe={{
        isActive: animated.isKeyframedAtTime,
        isDisabled: !isPlayheadWithinElementRange,
        onToggle: animated.toggleKeyframe,
    }}
/>
```

`PropertyParamField` puts the `KeyframeToggle` before the label and renders the value box for you.

**Slider bar.** A number param rendered through `PropertyParamField` also gets a draggable bar next to the exact-value `NumberField`: the bar spans `min..max` when the param has a `max`, or the explicit `slider: { min, max, pivot? }` on the param definition (display space; `slider: false` opts out). The bar only calls `onPreview` while dragging and `onCommit` once on release (a drag that ends where it started discards the preview instead), so keyframes and undo behave exactly as for the number box. Outside `PropertyParamField`, render `SliderField` (`components/ui/slider-field.tsx`). Required props: `value`, `slider`, `step`, `label`, `onPreview`, `onCommit` and `fieldProps` (the `NumberField` props: draft value and handlers). Optional: `unit` (spoken by screen readers), `onCancel` (defaults to discarding the timeline preview) and `onReset` (double-click on the thumb).

**For color fields**, declare the param with `type: "color"`. `PropertyParamField` then renders the `ColorPicker` and wires preview and commit through the same `useKeyframedParamProperty` hook.

---

## Checklist

- [ ] Path added to `ANIMATION_PROPERTY_PATHS` (fixed paths only)
- [ ] Param declared in `src/params/registry.ts` with a default, type and range
- [ ] Resolve call added where the value is used for rendering
- [ ] UI field uses `PropertyParamField` with `useKeyframedParamProperty` (not `usePropertyDraft`)
- [ ] `KeyframeToggle` added to the `SectionField`
- [ ] `onReset` calls `commitValue` (not `editor.timeline.updateElements` directly)
