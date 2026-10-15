# Stick to scene (camera tracking)

Select a text, image, sticker or graphic clip that sits over a video and press **Stick to scene**. The clip then stays glued to the scene while the camera pans, zooms, rolls or shakes: it moves, scales and rotates with the scene. It replaces the old single-point tracker ("Track a point"), which only followed a position.

Design and measurements: `docs/ccut/camera-tracking-v2.md`.

## How to use

1. Place a text, image, sticker or graphic clip over a video clip, where you want it **at the playhead**.
2. With the clip selected, press **Stick to scene**: the chip next to the clip in the preview, or the same button in the **Tracking** tab of the properties panel. There is nothing to pick and no region to choose.
3. The first time a video is used it is analysed, with a progress bar. **Cancel** or **Esc** stops it and leaves the clip untouched. Playback is paused meanwhile.
4. When it is done the clip shows **Stuck**, with **Unstick** and a **Follow** choice: **Scene** or **Moving object**. The mode is chosen automatically; one click flips it. If the spot you chose moves differently from the scene, the chip says so and offers **Use scene**.

Sticking a second or third clip to the same video reuses the analysis and is immediate, but only when the cached analysis covers the stretch of the video the new clip needs and has not been dropped. It is dropped when the project changes, when the video clip is deleted or plays other media, and, oldest first, when the session's analyses exceed the 64 MB cap. In those cases the video is analysed again, with the progress bar.

- **Starting mid-clip works.** The clip looks the same at the playhead and the scene's motion is added from there, in both directions.
- **Drag, scale or rotate a stuck clip** with the preview handles: it follows the cursor, and on release it is stuck again from the same analysis with the look you left it in.
- **Unstick**, or Ctrl+Z right after the stick, takes the pin off. Unstick leaves the clip where it is at the playhead, and Ctrl+Z after an Unstick puts the pin back.
- Sticking writes ordinary keyframes on the clip's five transform channels (`transform.positionX`, `positionY`, `scaleX`, `scaleY`, `rotate`) in one undo step, so preview, export and the keyframe editor all see the same thing. Only the stretch the analysis could follow gets keys; outside it the channels hold.

## What it does

- Analyses the video under the clip once, then solves any clip against that analysis. The video is read as grayscale frames at most 480 px wide, at the project frame rate capped at 30 fps. Features are tracked from frame to frame; the scene motion is fitted robustly, so objects moving through the shot do not pull it away.
- The motion model is chosen automatically. A similarity (move, scale, rotate) covers roll, zoom, hand shake and small pans. For pans and tilts, where the picture motion is a homography, the closest scale-and-rotate approximation over the area the clip covers is written instead.
- The result is stored as the clip's own five channels, simplified to one shared budget of about 0.5 canvas px in total, measured at the clip's corners and divided among the five channels (`simplify-channels.ts`, `pinTolerances`). It is not 0.5 px for each channel.
- The video under the clip is chosen among the visible videos on tracks below the clip's track that overlap the clip in time (hidden tracks and hidden videos are skipped; the topmost track first, and within a track the earliest start). It is the first one whose picture area contains the clip's centre at the playhead (held inside the clip's span); failing that, the topmost one that is on screen at that moment; failing that, the topmost one that meets the clip at all (`selectPinHost` in `pin-element.ts`). A clip that sits over no video says "There is no video under this clip." and cannot be stuck.
- The analysis is cached for the session, per video clip and media, up to 64 MB (the oldest-used go first). It is dropped when the video clip is deleted or plays other media, and when the project changes.

## Messages

The clip is left unchanged and no keys are written for:

- "Not enough detail in this clip to follow the scene." (flat, textured too little)
- "No camera movement in this clip, nothing to stick to."

The stick is applied, with a notice, for:

- "Scene cut at m:ss.s, stuck until there." (the pin ends at a cut)
- "Lost track of the scene part of the way, stuck until there."
- "Video quality is low, the stick may drift."
- "This spot moves differently from the scene: following the object." (with **Use scene**)

"The clip changed after sticking. Stick again." appears when the video under the clip was moved, trimmed or retimed after the stick.

## Limits

- **No perspective in the compositor.** The renderer draws a flat quad per clip, so a clip cannot be warped to a plane. For pans and tilts the closest scale-and-rotate is used. Small clips and small angles are fine; a **large** clip on a **wide** lens with a big pan (10 degrees and more, 25 degrees clearly) drifts at its corners and glides. Measured on synthetic footage at a 1920 px wide canvas with a 400 x 200 px clip, a 25 degree pan leaves 14-18 px of drift at a 60 degree field of view, and 24-35 px at a 90 degree field of view (a 200 x 100 px clip: 5-6 px and 8 px). Fixing that needs a compositor change, which is not done.
- **No parallax or 3D.** If foreground and background move at different speeds (walking shots), the clip sticks to the dominant layer.
- **A slow object that only starts to move later can still pull the stick.** Before it fits the scene, the solver sets aside features that part from the scene within 6 analysed frames of the frame you stuck at (0.2 s at 30 fps, longer at lower frame rates). An object that starts to drift after that window is not recognised and the stick can lean towards it. Seen on synthetic footage only; not measured on real footage.
- **Plain footage needed.** A flat wall or sky, very blurry or heavily compressed video does not work or only warns. Lens distortion and rolling shutter are not corrected. The measurements were made on synthetic footage; real footage is expected to be worse.
- **A small moving object with no texture** cannot be followed in Moving object mode.
- **Edits to the video after sticking are not followed.** The keys are baked. Moving, trimming or retiming the video leaves the clip behind and the chip asks you to stick again.
- **Unstick removes every key on the five channels inside the stretch the pin covered**, including keys you added there by hand.
- **Pins live for the session only.** Reloading the page forgets that a clip is stuck; the keyframes stay and can be removed with the keyframe editor. Stuck-ness shown in the UI also requires the pin record, which does not survive a reload.
- **One analysis at a time.** A second Stick while one runs is refused as busy.
- **The analysis runs on the main thread**, yielding to the interface between frames, not in a Worker. On one test machine the analysis of a 10 second 1080p clip took 3.7 s on average (worst 5.8 s); that is a measurement, not a promise, and other machines and clips will differ.

## Code

- `src/tracking/camera/`: the engine and its headless API. `tracker.ts` (features), `solve-pin.ts` and `similarity.ts`/`homography.ts` (the scene motion), `classify.ts` (scene or object, notices), `to-channels.ts` and `simplify-channels.ts` (the five channels), `pin-element.ts` (stick, re-stick, unstick), `analysis-service.ts`, `analysis-cache.ts` and `controller.ts` (the analysis job, cache and the controller registered with the store), `store.ts` (session state), `pin-view.ts`, `pin-actions.ts`, `pin-target.ts` (what the UI shows and does).
- `src/tracking/`: `frame-source.ts` (mediabunny to gray frames, its own `Input` per run), `sample-times.ts` (frame times with retime), `host.ts` (find the clip, the clip's bounds with presets), `projection.ts` (picture to canvas and back), `simplify.ts`.
- `src/tracking/components/` and `src/preview/components/pin-chip*.tsx`: the Tracking tab section and the chip. `src/preview/controllers/` re-sticks a stuck clip after drag, scale and rotate.
- `src/commands/timeline/element/keyframes/apply-camera-pin.ts`: the apply and remove commands, one undo step each.
- Tests: `bun test apps/web/src/tracking` from the repo root. The long numerical checks run with `CAMTRACK_FULL=1`, the speed checks with `PERF=1`.

## Why it is TypeScript

`AGENTS.md` says business logic goes to `rust/`. The tracker is TypeScript on purpose for now: `opencut-wasm` is a published npm dependency, so Rust changes there need a new release. The analysis consumes frames from an async iterable and returns plain typed arrays, so moving it into a worker or into Rust later means replacing the tracker and its driver.
