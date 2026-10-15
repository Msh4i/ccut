/* @ts-self-types="./opencut_wasm.d.ts" */

import * as wasm from "./opencut_wasm_bg.wasm";
import { __wbg_set_wasm } from "./opencut_wasm_bg.js";
__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    TICKS_PER_SECOND, applyEffectPasses, applyMaskFeather, floorToFrame, formatTimecode, getCompositorCanvas, getGpuErrorStats, getLastFrameProfile, guessTimecodeFormat, initCompositor, initializeGpu, isFrameAligned, lastFrameTime, mediaTimeAdd, mediaTimeClamp, mediaTimeFromFrame, mediaTimeFromSeconds, mediaTimeMax, mediaTimeMin, mediaTimeSub, mediaTimeToFrame, mediaTimeToSeconds, parseTimecode, releaseTexture, renderFrame, resizeCompositor, roundToFrame, snappedSeekTime, uploadTexture, uploadTextureReuse
} from "./opencut_wasm_bg.js";
