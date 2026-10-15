/**
 * @returns {number}
 */
export function TICKS_PER_SECOND() {
    const ret = wasm.TICKS_PER_SECOND();
    return ret;
}

/**
 * @param {any} options
 * @returns {OffscreenCanvas}
 */
export function applyEffectPasses(options) {
    const ret = wasm.applyEffectPasses(options);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {any} options
 * @returns {OffscreenCanvas}
 */
export function applyMaskFeather(options) {
    const ret = wasm.applyMaskFeather(options);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {FloorToFrameOptions} arg0
 * @returns {MediaTime | undefined}
 */
export function floorToFrame(arg0) {
    const ret = wasm.floorToFrame(arg0);
    return ret;
}

/**
 * @param {FormatTimecodeOptions} arg0
 * @returns {string | undefined}
 */
export function formatTimecode(arg0) {
    const ret = wasm.formatTimecode(arg0);
    let v1;
    if (ret[0] !== 0) {
        v1 = getStringFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v1;
}

/**
 * @returns {HTMLCanvasElement}
 */
export function getCompositorCanvas() {
    const ret = wasm.getCompositorCanvas();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Uncaptured GPU errors since `initializeGpu` (each distinct message is also
 * logged once to the console): `{ count: number, lastMessage: string | null }`.
 * Zero before the GPU is initialised.
 * @returns {object}
 */
export function getGpuErrorStats() {
    const ret = wasm.getGpuErrorStats();
    return ret;
}

/**
 * @returns {Array<any>}
 */
export function getLastFrameProfile() {
    const ret = wasm.getLastFrameProfile();
    return ret;
}

/**
 * @param {GuessTimecodeFormatOptions} arg0
 * @returns {TimeCodeFormat | undefined}
 */
export function guessTimecodeFormat(arg0) {
    const ret = wasm.guessTimecodeFormat(arg0);
    return ret;
}

/**
 * @param {number} width
 * @param {number} height
 */
export function initCompositor(width, height) {
    const ret = wasm.initCompositor(width, height);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @returns {Promise<void>}
 */
export function initializeGpu() {
    const ret = wasm.initializeGpu();
    return ret;
}

/**
 * @param {IsFrameAlignedOptions} arg0
 * @returns {boolean | undefined}
 */
export function isFrameAligned(arg0) {
    const ret = wasm.isFrameAligned(arg0);
    return ret === 0xFFFFFF ? undefined : ret !== 0;
}

/**
 * @param {LastFrameTimeOptions} arg0
 * @returns {MediaTime | undefined}
 */
export function lastFrameTime(arg0) {
    const ret = wasm.lastFrameTime(arg0);
    return ret;
}

/**
 * @param {MediaTimeAddOptions} arg0
 * @returns {MediaTime}
 */
export function mediaTimeAdd(arg0) {
    const ret = wasm.mediaTimeAdd(arg0);
    return ret;
}

/**
 * @param {MediaTimeClampOptions} arg0
 * @returns {MediaTime}
 */
export function mediaTimeClamp(arg0) {
    const ret = wasm.mediaTimeClamp(arg0);
    return ret;
}

/**
 * @param {MediaTimeFromFrameOptions} arg0
 * @returns {MediaTime | undefined}
 */
export function mediaTimeFromFrame(arg0) {
    const ret = wasm.mediaTimeFromFrame(arg0);
    return ret;
}

/**
 * @param {MediaTimeFromSecondsOptions} arg0
 * @returns {MediaTime | undefined}
 */
export function mediaTimeFromSeconds(arg0) {
    const ret = wasm.mediaTimeFromSeconds(arg0);
    return ret;
}

/**
 * @param {MediaTimeMaxOptions} arg0
 * @returns {MediaTime}
 */
export function mediaTimeMax(arg0) {
    const ret = wasm.mediaTimeMax(arg0);
    return ret;
}

/**
 * @param {MediaTimeMinOptions} arg0
 * @returns {MediaTime}
 */
export function mediaTimeMin(arg0) {
    const ret = wasm.mediaTimeMin(arg0);
    return ret;
}

/**
 * @param {MediaTimeSubOptions} arg0
 * @returns {MediaTime}
 */
export function mediaTimeSub(arg0) {
    const ret = wasm.mediaTimeSub(arg0);
    return ret;
}

/**
 * @param {MediaTimeToFrameOptions} arg0
 * @returns {bigint | undefined}
 */
export function mediaTimeToFrame(arg0) {
    const ret = wasm.mediaTimeToFrame(arg0);
    return ret[0] === 0 ? undefined : ret[1];
}

/**
 * @param {MediaTimeToSecondsOptions} arg0
 * @returns {number}
 */
export function mediaTimeToSeconds(arg0) {
    const ret = wasm.mediaTimeToSeconds(arg0);
    return ret;
}

/**
 * @param {ParseTimecodeOptions} arg0
 * @returns {MediaTime | undefined}
 */
export function parseTimecode(arg0) {
    const ret = wasm.parseTimecode(arg0);
    return ret;
}

/**
 * @param {string} id
 */
export function releaseTexture(id) {
    const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.releaseTexture(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @param {any} options
 */
export function renderFrame(options) {
    const ret = wasm.renderFrame(options);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @param {number} width
 * @param {number} height
 */
export function resizeCompositor(width, height) {
    const ret = wasm.resizeCompositor(width, height);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @param {RoundToFrameOptions} arg0
 * @returns {MediaTime | undefined}
 */
export function roundToFrame(arg0) {
    const ret = wasm.roundToFrame(arg0);
    return ret;
}

/**
 * @param {SnappedSeekTimeOptions} arg0
 * @returns {MediaTime | undefined}
 */
export function snappedSeekTime(arg0) {
    const ret = wasm.snappedSeekTime(arg0);
    return ret;
}

/**
 * @param {any} options
 */
export function uploadTexture(options) {
    const ret = wasm.uploadTexture(options);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * `uploadTexture`'s sibling for the playing preview (lever b): the source is an
 * OffscreenCanvas or an ImageBitmap, and a layer whose texture already has the
 * size gets the pixels copied into it instead of a new texture. Returns true
 * when it reused the texture, false when it created one. `uploadTexture` stays
 * as it was: the flag off means exactly its GPU commands.
 *
 * The copy is checked before it reaches wgpu (a copy larger than its source,
 * or a closed bitmap that reports 0x0, would panic inside wgpu and leave the
 * compositor dead): such a call returns an error and changes nothing.
 * @param {any} options
 * @returns {boolean}
 */
export function uploadTextureReuse(options) {
    const ret = wasm.uploadTextureReuse(options);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
export function __wbg_Error_7c536b7a8123d334(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_Number_d2ed9f811fff7051(arg0) {
    const ret = Number(arg0);
    return ret;
}
export function __wbg_String_8564e559799eccda(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_Window_5bac5165340af82e(arg0) {
    const ret = arg0.Window;
    return ret;
}
export function __wbg_WorkerGlobalScope_d0d150069210a6e8(arg0) {
    const ret = arg0.WorkerGlobalScope;
    return ret;
}
export function __wbg___wbindgen_bigint_get_as_i64_3d66614a210167c9(arg0, arg1) {
    const v = arg1;
    const ret = typeof(v) === 'bigint' ? v : undefined;
    getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_boolean_get_6abe7d340f528f63(arg0) {
    const v = arg0;
    const ret = typeof(v) === 'boolean' ? v : undefined;
    return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
}
export function __wbg___wbindgen_debug_string_8baecc377ad92880(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_in_840bcdd0dba8d13c(arg0, arg1) {
    const ret = arg0 in arg1;
    return ret;
}
export function __wbg___wbindgen_is_bigint_4393a1b8e13fdf64(arg0) {
    const ret = typeof(arg0) === 'bigint';
    return ret;
}
export function __wbg___wbindgen_is_function_d4c2480b46f29e33(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
}
export function __wbg___wbindgen_is_null_77356bc8da6bb199(arg0) {
    const ret = arg0 === null;
    return ret;
}
export function __wbg___wbindgen_is_object_e04e3a51a90cde43(arg0) {
    const val = arg0;
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
}
export function __wbg___wbindgen_is_string_3db04af369717583(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
}
export function __wbg___wbindgen_is_undefined_5957b329897cc39c(arg0) {
    const ret = arg0 === undefined;
    return ret;
}
export function __wbg___wbindgen_jsval_eq_8d2fb89b36afbec9(arg0, arg1) {
    const ret = arg0 === arg1;
    return ret;
}
export function __wbg___wbindgen_jsval_loose_eq_54779efa0bc46b0b(arg0, arg1) {
    const ret = arg0 == arg1;
    return ret;
}
export function __wbg___wbindgen_number_get_4fcba947d278ad7c(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'number' ? obj : undefined;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_string_get_ae6081df8158aa73(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'string' ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_throw_bd5a70920abf0236(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg__wbg_cb_unref_207c541c2d58dfb3(arg0) {
    arg0._wbg_cb_unref();
}
export function __wbg_activeTexture_9c2e6aa83f9ff71f(arg0, arg1) {
    arg0.activeTexture(arg1 >>> 0);
}
export function __wbg_activeTexture_d7776bac3a6d7d81(arg0, arg1) {
    arg0.activeTexture(arg1 >>> 0);
}
export function __wbg_attachShader_08f9dc290f7f21cc(arg0, arg1, arg2) {
    arg0.attachShader(arg1, arg2);
}
export function __wbg_attachShader_bf3db0e95841cd87(arg0, arg1, arg2) {
    arg0.attachShader(arg1, arg2);
}
export function __wbg_beginQuery_8177623d995ace6f(arg0, arg1, arg2) {
    arg0.beginQuery(arg1 >>> 0, arg2);
}
export function __wbg_beginRenderPass_a19cc6156a7858b4() { return handleError(function (arg0, arg1) {
    const ret = arg0.beginRenderPass(arg1);
    return ret;
}, arguments); }
export function __wbg_bindAttribLocation_89c2713acf4dd995(arg0, arg1, arg2, arg3, arg4) {
    arg0.bindAttribLocation(arg1, arg2 >>> 0, getStringFromWasm0(arg3, arg4));
}
export function __wbg_bindAttribLocation_de6ec2ac7d3f92aa(arg0, arg1, arg2, arg3, arg4) {
    arg0.bindAttribLocation(arg1, arg2 >>> 0, getStringFromWasm0(arg3, arg4));
}
export function __wbg_bindBufferRange_67e7b18d43028a1e(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.bindBufferRange(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
}
export function __wbg_bindBuffer_7e9a97580c172350(arg0, arg1, arg2) {
    arg0.bindBuffer(arg1 >>> 0, arg2);
}
export function __wbg_bindBuffer_dfc10755fbcf7688(arg0, arg1, arg2) {
    arg0.bindBuffer(arg1 >>> 0, arg2);
}
export function __wbg_bindFramebuffer_c2bbe6dfa5c632ff(arg0, arg1, arg2) {
    arg0.bindFramebuffer(arg1 >>> 0, arg2);
}
export function __wbg_bindFramebuffer_ea890cc1c43ad089(arg0, arg1, arg2) {
    arg0.bindFramebuffer(arg1 >>> 0, arg2);
}
export function __wbg_bindRenderbuffer_324fd91405ebdb55(arg0, arg1, arg2) {
    arg0.bindRenderbuffer(arg1 >>> 0, arg2);
}
export function __wbg_bindRenderbuffer_d4e73537cc3c23dd(arg0, arg1, arg2) {
    arg0.bindRenderbuffer(arg1 >>> 0, arg2);
}
export function __wbg_bindSampler_81550d380ef83fde(arg0, arg1, arg2) {
    arg0.bindSampler(arg1 >>> 0, arg2);
}
export function __wbg_bindTexture_9560807e79c79e9e(arg0, arg1, arg2) {
    arg0.bindTexture(arg1 >>> 0, arg2);
}
export function __wbg_bindTexture_adcc93a197a861bd(arg0, arg1, arg2) {
    arg0.bindTexture(arg1 >>> 0, arg2);
}
export function __wbg_bindVertexArrayOES_5a903bbe60cd30d4(arg0, arg1) {
    arg0.bindVertexArrayOES(arg1);
}
export function __wbg_bindVertexArray_b536f88ef905a6ac(arg0, arg1) {
    arg0.bindVertexArray(arg1);
}
export function __wbg_blendColor_0dc1b9e2e8699cf8(arg0, arg1, arg2, arg3, arg4) {
    arg0.blendColor(arg1, arg2, arg3, arg4);
}
export function __wbg_blendColor_347ae83996a6cf78(arg0, arg1, arg2, arg3, arg4) {
    arg0.blendColor(arg1, arg2, arg3, arg4);
}
export function __wbg_blendEquationSeparate_9f1e2055fa2e7076(arg0, arg1, arg2) {
    arg0.blendEquationSeparate(arg1 >>> 0, arg2 >>> 0);
}
export function __wbg_blendEquationSeparate_9f64c05b6971ddb3(arg0, arg1, arg2) {
    arg0.blendEquationSeparate(arg1 >>> 0, arg2 >>> 0);
}
export function __wbg_blendEquation_187168667c5442a4(arg0, arg1) {
    arg0.blendEquation(arg1 >>> 0);
}
export function __wbg_blendEquation_43c3d3a039205033(arg0, arg1) {
    arg0.blendEquation(arg1 >>> 0);
}
export function __wbg_blendFuncSeparate_56946f7dffea79ff(arg0, arg1, arg2, arg3, arg4) {
    arg0.blendFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
}
export function __wbg_blendFuncSeparate_cb15d1499ea79a3a(arg0, arg1, arg2, arg3, arg4) {
    arg0.blendFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
}
export function __wbg_blendFunc_34451c1da68c6f91(arg0, arg1, arg2) {
    arg0.blendFunc(arg1 >>> 0, arg2 >>> 0);
}
export function __wbg_blendFunc_7f6cfa190353236a(arg0, arg1, arg2) {
    arg0.blendFunc(arg1 >>> 0, arg2 >>> 0);
}
export function __wbg_blitFramebuffer_5765344141e52d50(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
    arg0.blitFramebuffer(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0);
}
export function __wbg_bufferData_2e9c7448cdc06bcf(arg0, arg1, arg2, arg3) {
    arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
}
export function __wbg_bufferData_2eb007f9cc031f1d(arg0, arg1, arg2, arg3) {
    arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
}
export function __wbg_bufferData_f4e0d5b42151db0a(arg0, arg1, arg2, arg3) {
    arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
}
export function __wbg_bufferData_fccd5262811b54a2(arg0, arg1, arg2, arg3) {
    arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
}
export function __wbg_bufferSubData_35ff920f72ac71da(arg0, arg1, arg2, arg3) {
    arg0.bufferSubData(arg1 >>> 0, arg2, arg3);
}
export function __wbg_bufferSubData_40bca454022e641b(arg0, arg1, arg2, arg3) {
    arg0.bufferSubData(arg1 >>> 0, arg2, arg3);
}
export function __wbg_call_1aea13500fe8ff6c() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_call_faf6b66fc4667ce6() { return handleError(function (arg0, arg1) {
    const ret = arg0.call(arg1);
    return ret;
}, arguments); }
export function __wbg_clearBufferfv_a31a72ea53e2a9ce(arg0, arg1, arg2, arg3, arg4) {
    arg0.clearBufferfv(arg1 >>> 0, arg2, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_clearBufferiv_b6a791b01cf2df33(arg0, arg1, arg2, arg3, arg4) {
    arg0.clearBufferiv(arg1 >>> 0, arg2, getArrayI32FromWasm0(arg3, arg4));
}
export function __wbg_clearBufferuiv_072a39776be89ce3(arg0, arg1, arg2, arg3, arg4) {
    arg0.clearBufferuiv(arg1 >>> 0, arg2, getArrayU32FromWasm0(arg3, arg4));
}
export function __wbg_clearDepth_4d2ae05a73397b01(arg0, arg1) {
    arg0.clearDepth(arg1);
}
export function __wbg_clearDepth_d2694099c8ee7291(arg0, arg1) {
    arg0.clearDepth(arg1);
}
export function __wbg_clearRect_88636c02608eb9dd(arg0, arg1, arg2, arg3, arg4) {
    arg0.clearRect(arg1, arg2, arg3, arg4);
}
export function __wbg_clearStencil_85cd03270e3236df(arg0, arg1) {
    arg0.clearStencil(arg1);
}
export function __wbg_clearStencil_ff91a6538b8f6bb9(arg0, arg1) {
    arg0.clearStencil(arg1);
}
export function __wbg_clear_02b91fe3c1160f4b(arg0, arg1) {
    arg0.clear(arg1 >>> 0);
}
export function __wbg_clear_fec66fb050661e6a(arg0, arg1) {
    arg0.clear(arg1 >>> 0);
}
export function __wbg_clientWaitSync_6523a0f72c96027e(arg0, arg1, arg2, arg3) {
    const ret = arg0.clientWaitSync(arg1, arg2 >>> 0, arg3 >>> 0);
    return ret;
}
export function __wbg_colorMask_9af657e57e8c55fc(arg0, arg1, arg2, arg3, arg4) {
    arg0.colorMask(arg1 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
}
export function __wbg_colorMask_fe066b286e037add(arg0, arg1, arg2, arg3, arg4) {
    arg0.colorMask(arg1 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
}
export function __wbg_compileShader_b489b59d862a0656(arg0, arg1) {
    arg0.compileShader(arg1);
}
export function __wbg_compileShader_e1741f6f6b22f200(arg0, arg1) {
    arg0.compileShader(arg1);
}
export function __wbg_compressedTexSubImage2D_5b24c508183bc3f5(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8);
}
export function __wbg_compressedTexSubImage2D_7e034e3faa8ff6ae(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8);
}
export function __wbg_compressedTexSubImage2D_a5d4bd631d195993(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8, arg9);
}
export function __wbg_compressedTexSubImage3D_8646da3500c5c744(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
    arg0.compressedTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10);
}
export function __wbg_compressedTexSubImage3D_879cbe501eb47666(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    arg0.compressedTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10, arg11);
}
export function __wbg_configure_16541864db644c70() { return handleError(function (arg0, arg1) {
    arg0.configure(arg1);
}, arguments); }
export function __wbg_copyBufferSubData_73c882b259d2e2b6(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.copyBufferSubData(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
}
export function __wbg_copyExternalImageToTexture_6d56ad685a99824d() { return handleError(function (arg0, arg1, arg2, arg3) {
    arg0.copyExternalImageToTexture(arg1, arg2, arg3);
}, arguments); }
export function __wbg_copyTexSubImage2D_74ead2da76740798(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    arg0.copyTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
}
export function __wbg_copyTexSubImage2D_c4a40be8868d9a14(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    arg0.copyTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
}
export function __wbg_copyTexSubImage3D_9d7f3a533a7ab416(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.copyTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
}
export function __wbg_createBindGroupLayout_adb8337a6808ae24() { return handleError(function (arg0, arg1) {
    const ret = arg0.createBindGroupLayout(arg1);
    return ret;
}, arguments); }
export function __wbg_createBindGroup_91159ca759115307(arg0, arg1) {
    const ret = arg0.createBindGroup(arg1);
    return ret;
}
export function __wbg_createBuffer_59de141e89014140() { return handleError(function (arg0, arg1) {
    const ret = arg0.createBuffer(arg1);
    return ret;
}, arguments); }
export function __wbg_createBuffer_634aae6afc8603fa(arg0) {
    const ret = arg0.createBuffer();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createBuffer_cb32bba0a245b5f0(arg0) {
    const ret = arg0.createBuffer();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createCommandEncoder_dc2b2ca6f09bd4c3(arg0, arg1) {
    const ret = arg0.createCommandEncoder(arg1);
    return ret;
}
export function __wbg_createElement_22af76933a7b7e81() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.createElement(getStringFromWasm0(arg1, arg2));
    return ret;
}, arguments); }
export function __wbg_createFramebuffer_1a30da56415d8128(arg0) {
    const ret = arg0.createFramebuffer();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createFramebuffer_bec24194763552b8(arg0) {
    const ret = arg0.createFramebuffer();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createPipelineLayout_a5290f84492f8b1e(arg0, arg1) {
    const ret = arg0.createPipelineLayout(arg1);
    return ret;
}
export function __wbg_createProgram_b20375f7e07e4565(arg0) {
    const ret = arg0.createProgram();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createProgram_eeb811f1092e4e66(arg0) {
    const ret = arg0.createProgram();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createQuery_e98e22ea5c4199f3(arg0) {
    const ret = arg0.createQuery();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createRenderPipeline_f7aca470ad8ce865() { return handleError(function (arg0, arg1) {
    const ret = arg0.createRenderPipeline(arg1);
    return ret;
}, arguments); }
export function __wbg_createRenderbuffer_a43f5cf814af62c8(arg0) {
    const ret = arg0.createRenderbuffer();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createRenderbuffer_ed399557e8acdba7(arg0) {
    const ret = arg0.createRenderbuffer();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createSampler_40d3d1808ce4ccf0(arg0) {
    const ret = arg0.createSampler();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createSampler_6b972cd00bcc5dfb(arg0, arg1) {
    const ret = arg0.createSampler(arg1);
    return ret;
}
export function __wbg_createShaderModule_bbe0476992dd060e(arg0, arg1) {
    const ret = arg0.createShaderModule(arg1);
    return ret;
}
export function __wbg_createShader_828e81c3b01299f7(arg0, arg1) {
    const ret = arg0.createShader(arg1 >>> 0);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createShader_a68df73e8615cf7f(arg0, arg1) {
    const ret = arg0.createShader(arg1 >>> 0);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createTexture_011d4b0badf853e3() { return handleError(function (arg0, arg1) {
    const ret = arg0.createTexture(arg1);
    return ret;
}, arguments); }
export function __wbg_createTexture_64eb57187dc16330(arg0) {
    const ret = arg0.createTexture();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createTexture_bdd2fd7604c04839(arg0) {
    const ret = arg0.createTexture();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createVertexArrayOES_17388a7ebf4b7bfe(arg0) {
    const ret = arg0.createVertexArrayOES();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createVertexArray_7c2c139cdda744b5(arg0) {
    const ret = arg0.createVertexArray();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createView_1ef8f1ddc16facb0() { return handleError(function (arg0, arg1) {
    const ret = arg0.createView(arg1);
    return ret;
}, arguments); }
export function __wbg_cullFace_2ac6820d8be3569b(arg0, arg1) {
    arg0.cullFace(arg1 >>> 0);
}
export function __wbg_cullFace_b47f0b5ff6fbc4e8(arg0, arg1) {
    arg0.cullFace(arg1 >>> 0);
}
export function __wbg_data_cfe3a2a875ad7522(arg0, arg1) {
    const ret = arg1.data;
    const ptr1 = passArray8ToWasm0(ret, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_deleteBuffer_431cacf83f504e90(arg0, arg1) {
    arg0.deleteBuffer(arg1);
}
export function __wbg_deleteBuffer_fa6436606df27f35(arg0, arg1) {
    arg0.deleteBuffer(arg1);
}
export function __wbg_deleteFramebuffer_92b5885f27fc8283(arg0, arg1) {
    arg0.deleteFramebuffer(arg1);
}
export function __wbg_deleteFramebuffer_a44089e317a80c64(arg0, arg1) {
    arg0.deleteFramebuffer(arg1);
}
export function __wbg_deleteProgram_4a768b09bc35123b(arg0, arg1) {
    arg0.deleteProgram(arg1);
}
export function __wbg_deleteProgram_b37d748df05b3396(arg0, arg1) {
    arg0.deleteProgram(arg1);
}
export function __wbg_deleteQuery_493454abb4e57041(arg0, arg1) {
    arg0.deleteQuery(arg1);
}
export function __wbg_deleteRenderbuffer_5195180823a72395(arg0, arg1) {
    arg0.deleteRenderbuffer(arg1);
}
export function __wbg_deleteRenderbuffer_f57b915555c0b855(arg0, arg1) {
    arg0.deleteRenderbuffer(arg1);
}
export function __wbg_deleteSampler_8e2035a696360764(arg0, arg1) {
    arg0.deleteSampler(arg1);
}
export function __wbg_deleteShader_7ccf49592116c727(arg0, arg1) {
    arg0.deleteShader(arg1);
}
export function __wbg_deleteShader_b90b1e4c164edffd(arg0, arg1) {
    arg0.deleteShader(arg1);
}
export function __wbg_deleteSync_fa5d1de5dd19d2c0(arg0, arg1) {
    arg0.deleteSync(arg1);
}
export function __wbg_deleteTexture_b1d80c8269d61722(arg0, arg1) {
    arg0.deleteTexture(arg1);
}
export function __wbg_deleteTexture_cebd404ba7d6b782(arg0, arg1) {
    arg0.deleteTexture(arg1);
}
export function __wbg_deleteVertexArrayOES_9af70f97832b5500(arg0, arg1) {
    arg0.deleteVertexArrayOES(arg1);
}
export function __wbg_deleteVertexArray_145a499e098e8794(arg0, arg1) {
    arg0.deleteVertexArray(arg1);
}
export function __wbg_depthFunc_23bf1b6bd274f948(arg0, arg1) {
    arg0.depthFunc(arg1 >>> 0);
}
export function __wbg_depthFunc_a43f1c731109915b(arg0, arg1) {
    arg0.depthFunc(arg1 >>> 0);
}
export function __wbg_depthMask_66724117973b6ff9(arg0, arg1) {
    arg0.depthMask(arg1 !== 0);
}
export function __wbg_depthMask_c935705cda44d8be(arg0, arg1) {
    arg0.depthMask(arg1 !== 0);
}
export function __wbg_depthRange_9feb49867173e854(arg0, arg1, arg2) {
    arg0.depthRange(arg1, arg2);
}
export function __wbg_depthRange_e827bfffaf500974(arg0, arg1, arg2) {
    arg0.depthRange(arg1, arg2);
}
export function __wbg_description_972ee565dde8fe3f(arg0, arg1) {
    const ret = arg1.description;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_destroy_479a1ccb4eb28cd7(arg0) {
    arg0.destroy();
}
export function __wbg_destroy_f93c404bce2c3665(arg0) {
    arg0.destroy();
}
export function __wbg_disableVertexAttribArray_7719cf9351a6e469(arg0, arg1) {
    arg0.disableVertexAttribArray(arg1 >>> 0);
}
export function __wbg_disableVertexAttribArray_d4213fe0bc2a5347(arg0, arg1) {
    arg0.disableVertexAttribArray(arg1 >>> 0);
}
export function __wbg_disable_289f67dd5f931fca(arg0, arg1) {
    arg0.disable(arg1 >>> 0);
}
export function __wbg_disable_34e3af368545441a(arg0, arg1) {
    arg0.disable(arg1 >>> 0);
}
export function __wbg_document_8d00b6db6f4e3e5e(arg0) {
    const ret = arg0.document;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_done_e0b2820e599cb9f4(arg0) {
    const ret = arg0.done;
    return ret;
}
export function __wbg_drawArraysInstancedANGLE_d34b18d63f59d479(arg0, arg1, arg2, arg3, arg4) {
    arg0.drawArraysInstancedANGLE(arg1 >>> 0, arg2, arg3, arg4);
}
export function __wbg_drawArraysInstanced_b238073b7bcc6a32(arg0, arg1, arg2, arg3, arg4) {
    arg0.drawArraysInstanced(arg1 >>> 0, arg2, arg3, arg4);
}
export function __wbg_drawArrays_4ede7221e809def6(arg0, arg1, arg2, arg3) {
    arg0.drawArrays(arg1 >>> 0, arg2, arg3);
}
export function __wbg_drawArrays_7330b8ea4a2497ba(arg0, arg1, arg2, arg3) {
    arg0.drawArrays(arg1 >>> 0, arg2, arg3);
}
export function __wbg_drawBuffersWEBGL_fa949d7e1f2f15a2(arg0, arg1) {
    arg0.drawBuffersWEBGL(arg1);
}
export function __wbg_drawBuffers_a4461e8723df471c(arg0, arg1) {
    arg0.drawBuffers(arg1);
}
export function __wbg_drawElementsInstancedANGLE_7a4a6e6d9f591778(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.drawElementsInstancedANGLE(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
}
export function __wbg_drawElementsInstanced_85db7045d67748ac(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.drawElementsInstanced(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
}
export function __wbg_drawImage_df3e4a3282b52a97() { return handleError(function (arg0, arg1, arg2, arg3) {
    arg0.drawImage(arg1, arg2, arg3);
}, arguments); }
export function __wbg_draw_9a35daa0096c6f2c(arg0, arg1, arg2, arg3, arg4) {
    arg0.draw(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
}
export function __wbg_enableVertexAttribArray_a349186274ae7f6e(arg0, arg1) {
    arg0.enableVertexAttribArray(arg1 >>> 0);
}
export function __wbg_enableVertexAttribArray_ebc5e5c3005f1bd8(arg0, arg1) {
    arg0.enableVertexAttribArray(arg1 >>> 0);
}
export function __wbg_enable_78737d68d27bc055(arg0, arg1) {
    arg0.enable(arg1 >>> 0);
}
export function __wbg_enable_bd9bfea24edbfe6f(arg0, arg1) {
    arg0.enable(arg1 >>> 0);
}
export function __wbg_endQuery_17dba0e9a629778e(arg0, arg1) {
    arg0.endQuery(arg1 >>> 0);
}
export function __wbg_end_1db12af2e0ff1235(arg0) {
    arg0.end();
}
export function __wbg_entries_e234c7de8150095c(arg0) {
    const ret = Object.entries(arg0);
    return ret;
}
export function __wbg_error_093b32bf1b0b51c6(arg0, arg1) {
    console.error(getStringFromWasm0(arg0, arg1));
}
export function __wbg_error_a6fa202b58aa1cd3(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
}
export function __wbg_error_c9510133954a995f(arg0) {
    const ret = arg0.error;
    return ret;
}
export function __wbg_fenceSync_910518819efb411a(arg0, arg1, arg2) {
    const ret = arg0.fenceSync(arg1 >>> 0, arg2 >>> 0);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_finish_48a7b6da7b76999e(arg0) {
    const ret = arg0.finish();
    return ret;
}
export function __wbg_finish_68d7c5925d3fa394(arg0, arg1) {
    const ret = arg0.finish(arg1);
    return ret;
}
export function __wbg_flush_ccba3f5fdb5013a1(arg0) {
    arg0.flush();
}
export function __wbg_flush_f291478eb0dcb239(arg0) {
    arg0.flush();
}
export function __wbg_framebufferRenderbuffer_1b2108ac472b1c17(arg0, arg1, arg2, arg3, arg4) {
    arg0.framebufferRenderbuffer(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
}
export function __wbg_framebufferRenderbuffer_53e70e3ca11fc094(arg0, arg1, arg2, arg3, arg4) {
    arg0.framebufferRenderbuffer(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
}
export function __wbg_framebufferTexture2D_3ca9eab3ad6f1ac1(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.framebufferTexture2D(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5);
}
export function __wbg_framebufferTexture2D_eb2cdce93b74334f(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.framebufferTexture2D(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5);
}
export function __wbg_framebufferTextureLayer_6d50955448761952(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.framebufferTextureLayer(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
}
export function __wbg_framebufferTextureMultiviewOVR_de47033d076a1c65(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.framebufferTextureMultiviewOVR(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5, arg6);
}
export function __wbg_frontFace_00ef7686d1b1088a(arg0, arg1) {
    arg0.frontFace(arg1 >>> 0);
}
export function __wbg_frontFace_46fec56cf60a27cb(arg0, arg1) {
    arg0.frontFace(arg1 >>> 0);
}
export function __wbg_getBufferSubData_1527fe409d7636a0(arg0, arg1, arg2, arg3) {
    arg0.getBufferSubData(arg1 >>> 0, arg2, arg3);
}
export function __wbg_getContext_064ba67b26a73a3e() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.getContext(getStringFromWasm0(arg1, arg2));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_getContext_30f7143eeaed637c() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.getContext(getStringFromWasm0(arg1, arg2));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_getContext_729adedba115e573() { return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = arg0.getContext(getStringFromWasm0(arg1, arg2), arg3);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_getContext_a527af8fecba2087() { return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = arg0.getContext(getStringFromWasm0(arg1, arg2), arg3);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_getCurrentTexture_9b00da7f6bc38606() { return handleError(function (arg0) {
    const ret = arg0.getCurrentTexture();
    return ret;
}, arguments); }
export function __wbg_getExtension_accec60a148bde49() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.getExtension(getStringFromWasm0(arg1, arg2));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_getImageData_767c4f63fc5e613d() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    const ret = arg0.getImageData(arg1, arg2, arg3, arg4);
    return ret;
}, arguments); }
export function __wbg_getIndexedParameter_de1acfd67158f312() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.getIndexedParameter(arg1 >>> 0, arg2 >>> 0);
    return ret;
}, arguments); }
export function __wbg_getMappedRange_4a3dc3f452433b71() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.getMappedRange(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_getParameter_1a896a8dcca1c4fa() { return handleError(function (arg0, arg1) {
    const ret = arg0.getParameter(arg1 >>> 0);
    return ret;
}, arguments); }
export function __wbg_getParameter_7be23eeb6876b790() { return handleError(function (arg0, arg1) {
    const ret = arg0.getParameter(arg1 >>> 0);
    return ret;
}, arguments); }
export function __wbg_getPreferredCanvasFormat_54381f1ef7aec03d(arg0) {
    const ret = arg0.getPreferredCanvasFormat();
    return (__wbindgen_enum_GpuTextureFormat.indexOf(ret) + 1 || 96) - 1;
}
export function __wbg_getProgramInfoLog_6f8aa7c1b37d4140(arg0, arg1, arg2) {
    const ret = arg1.getProgramInfoLog(arg2);
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_getProgramInfoLog_8a6ecb6668e998d1(arg0, arg1, arg2) {
    const ret = arg1.getProgramInfoLog(arg2);
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_getProgramParameter_8f31caa7326d56ff(arg0, arg1, arg2) {
    const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
    return ret;
}
export function __wbg_getProgramParameter_a6da442bd18f71ea(arg0, arg1, arg2) {
    const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
    return ret;
}
export function __wbg_getQueryParameter_ca0185333ff24acf(arg0, arg1, arg2) {
    const ret = arg0.getQueryParameter(arg1, arg2 >>> 0);
    return ret;
}
export function __wbg_getShaderInfoLog_4a30ecb2bca0a8fd(arg0, arg1, arg2) {
    const ret = arg1.getShaderInfoLog(arg2);
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_getShaderInfoLog_fb2b3e5488623f52(arg0, arg1, arg2) {
    const ret = arg1.getShaderInfoLog(arg2);
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_getShaderParameter_1289544e6a149b67(arg0, arg1, arg2) {
    const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
    return ret;
}
export function __wbg_getShaderParameter_34d1e384ebb29665(arg0, arg1, arg2) {
    const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
    return ret;
}
export function __wbg_getSupportedExtensions_fa152e3812b9efef(arg0) {
    const ret = arg0.getSupportedExtensions();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_getSupportedProfiles_6935d344271bf832(arg0) {
    const ret = arg0.getSupportedProfiles();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_getSyncParameter_2510b5abbf0df600(arg0, arg1, arg2) {
    const ret = arg0.getSyncParameter(arg1, arg2 >>> 0);
    return ret;
}
export function __wbg_getUniformBlockIndex_88fc6cbcfe931148(arg0, arg1, arg2, arg3) {
    const ret = arg0.getUniformBlockIndex(arg1, getStringFromWasm0(arg2, arg3));
    return ret;
}
export function __wbg_getUniformLocation_141c8d21824a1679(arg0, arg1, arg2, arg3) {
    const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_getUniformLocation_83c8ff312ccadd3a(arg0, arg1, arg2, arg3) {
    const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_get_480fa63526daa580(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_get_8944f33c9c7f4f6c(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return ret;
}
export function __wbg_get_97a4b9029a97fbd6() { return handleError(function (arg0, arg1) {
    const ret = Reflect.get(arg0, arg1);
    return ret;
}, arguments); }
export function __wbg_get_d8a3d51a73d14c8a() { return handleError(function (arg0, arg1) {
    const ret = Reflect.get(arg0, arg1);
    return ret;
}, arguments); }
export function __wbg_get_unchecked_c33f0e513c522d7c(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return ret;
}
export function __wbg_get_with_ref_key_6412cf3094599694(arg0, arg1) {
    const ret = arg0[arg1];
    return ret;
}
export function __wbg_gpu_3f9d7df9a18237f8(arg0) {
    const ret = arg0.gpu;
    return ret;
}
export function __wbg_height_599ce151f78a7ce4(arg0) {
    const ret = arg0.height;
    return ret;
}
export function __wbg_height_8b6fea8d47c5e971(arg0) {
    const ret = arg0.height;
    return ret;
}
export function __wbg_height_8ba0d55527fe8f18(arg0) {
    const ret = arg0.height;
    return ret;
}
export function __wbg_height_c4e90de06690eaec(arg0) {
    const ret = arg0.height;
    return ret;
}
export function __wbg_height_f3205fe0db73972c(arg0) {
    const ret = arg0.height;
    return ret;
}
export function __wbg_includes_907769f1752a98ff(arg0, arg1, arg2) {
    const ret = arg0.includes(arg1, arg2);
    return ret;
}
export function __wbg_info_46732e46da34944d(arg0) {
    const ret = arg0.info;
    return ret;
}
export function __wbg_instanceof_ArrayBuffer_046631d47961f5fe(arg0) {
    let result;
    try {
        result = arg0 instanceof ArrayBuffer;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_GpuAdapter_dc7e13c1676da9bd(arg0) {
    let result;
    try {
        result = arg0 instanceof GPUAdapter;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_GpuCanvasContext_c2609c698a76a6b6(arg0) {
    let result;
    try {
        result = arg0 instanceof GPUCanvasContext;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_GpuOutOfMemoryError_71010a519adf2661(arg0) {
    let result;
    try {
        result = arg0 instanceof GPUOutOfMemoryError;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_GpuValidationError_a2f8dbe5d7c71adf(arg0) {
    let result;
    try {
        result = arg0 instanceof GPUValidationError;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_HtmlCanvasElement_1ee070c578ed9cdc(arg0) {
    let result;
    try {
        result = arg0 instanceof HTMLCanvasElement;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_ImageBitmap_1606fd65ff750776(arg0) {
    let result;
    try {
        result = arg0 instanceof ImageBitmap;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Map_4b9c368d84df6811(arg0) {
    let result;
    try {
        result = arg0 instanceof Map;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Object_a99dcb8b396fa196(arg0) {
    let result;
    try {
        result = arg0 instanceof Object;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_OffscreenCanvas_34012446c4da8c89(arg0) {
    let result;
    try {
        result = arg0 instanceof OffscreenCanvas;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Uint8Array_e7d245baab296394(arg0) {
    let result;
    try {
        result = arg0 instanceof Uint8Array;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_WebGl2RenderingContext_b0fd328023d101b2(arg0) {
    let result;
    try {
        result = arg0 instanceof WebGL2RenderingContext;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Window_4bfad3a9470c25c9(arg0) {
    let result;
    try {
        result = arg0 instanceof Window;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_invalidateFramebuffer_5bc63f92473c0b28() { return handleError(function (arg0, arg1, arg2) {
    arg0.invalidateFramebuffer(arg1 >>> 0, arg2);
}, arguments); }
export function __wbg_isArray_8dc932f4b6997756(arg0) {
    const ret = Array.isArray(arg0);
    return ret;
}
export function __wbg_isSafeInteger_db44a36710ec7a10(arg0) {
    const ret = Number.isSafeInteger(arg0);
    return ret;
}
export function __wbg_is_04cfa9fd1c38e170(arg0, arg1) {
    const ret = Object.is(arg0, arg1);
    return ret;
}
export function __wbg_iterator_8af67730d17a1376() {
    const ret = Symbol.iterator;
    return ret;
}
export function __wbg_label_18cae34ff19933d7(arg0, arg1) {
    const ret = arg1.label;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_length_090b6aa6235450ba(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_length_713cc1160ce7b5b9(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_limits_8837ca9ac1296563(arg0) {
    const ret = arg0.limits;
    return ret;
}
export function __wbg_linkProgram_47357d3d0a10d366(arg0, arg1) {
    arg0.linkProgram(arg1);
}
export function __wbg_linkProgram_4f362b048cee2c35(arg0, arg1) {
    arg0.linkProgram(arg1);
}
export function __wbg_mapAsync_288e2fddbc3f7f7b(arg0, arg1, arg2, arg3) {
    const ret = arg0.mapAsync(arg1 >>> 0, arg2, arg3);
    return ret;
}
export function __wbg_maxBindGroups_3e48365ce9cb69b2(arg0) {
    const ret = arg0.maxBindGroups;
    return ret;
}
export function __wbg_maxBindingsPerBindGroup_19eab6283879be75(arg0) {
    const ret = arg0.maxBindingsPerBindGroup;
    return ret;
}
export function __wbg_maxBufferSize_8086300d000af7cb(arg0) {
    const ret = arg0.maxBufferSize;
    return ret;
}
export function __wbg_maxColorAttachmentBytesPerSample_ee822e1793bea12f(arg0) {
    const ret = arg0.maxColorAttachmentBytesPerSample;
    return ret;
}
export function __wbg_maxColorAttachments_3110f22e4c5e3621(arg0) {
    const ret = arg0.maxColorAttachments;
    return ret;
}
export function __wbg_maxComputeInvocationsPerWorkgroup_e1b61d9c74f79e81(arg0) {
    const ret = arg0.maxComputeInvocationsPerWorkgroup;
    return ret;
}
export function __wbg_maxComputeWorkgroupSizeX_202ebe3252c09676(arg0) {
    const ret = arg0.maxComputeWorkgroupSizeX;
    return ret;
}
export function __wbg_maxComputeWorkgroupSizeY_4f66f59c2daaa8f1(arg0) {
    const ret = arg0.maxComputeWorkgroupSizeY;
    return ret;
}
export function __wbg_maxComputeWorkgroupSizeZ_eadb1eb36902e045(arg0) {
    const ret = arg0.maxComputeWorkgroupSizeZ;
    return ret;
}
export function __wbg_maxComputeWorkgroupStorageSize_05e0131572ec6c1e(arg0) {
    const ret = arg0.maxComputeWorkgroupStorageSize;
    return ret;
}
export function __wbg_maxComputeWorkgroupsPerDimension_47cd4aa37eba4a57(arg0) {
    const ret = arg0.maxComputeWorkgroupsPerDimension;
    return ret;
}
export function __wbg_maxDynamicStorageBuffersPerPipelineLayout_122112462e514d25(arg0) {
    const ret = arg0.maxDynamicStorageBuffersPerPipelineLayout;
    return ret;
}
export function __wbg_maxDynamicUniformBuffersPerPipelineLayout_4c57dbd81a8d1c49(arg0) {
    const ret = arg0.maxDynamicUniformBuffersPerPipelineLayout;
    return ret;
}
export function __wbg_maxInterStageShaderVariables_5bb90c2a06f1e9ce(arg0) {
    const ret = arg0.maxInterStageShaderVariables;
    return ret;
}
export function __wbg_maxSampledTexturesPerShaderStage_cea16550f969bbdc(arg0) {
    const ret = arg0.maxSampledTexturesPerShaderStage;
    return ret;
}
export function __wbg_maxSamplersPerShaderStage_1cbd8dba92d87dd9(arg0) {
    const ret = arg0.maxSamplersPerShaderStage;
    return ret;
}
export function __wbg_maxStorageBufferBindingSize_ff2e77e686018944(arg0) {
    const ret = arg0.maxStorageBufferBindingSize;
    return ret;
}
export function __wbg_maxStorageBuffersPerShaderStage_e496ad22f8b97f12(arg0) {
    const ret = arg0.maxStorageBuffersPerShaderStage;
    return ret;
}
export function __wbg_maxStorageTexturesPerShaderStage_258aab0d332d9efe(arg0) {
    const ret = arg0.maxStorageTexturesPerShaderStage;
    return ret;
}
export function __wbg_maxTextureArrayLayers_6fffbda0cd6f3036(arg0) {
    const ret = arg0.maxTextureArrayLayers;
    return ret;
}
export function __wbg_maxTextureDimension1D_53d154cf8f16d439(arg0) {
    const ret = arg0.maxTextureDimension1D;
    return ret;
}
export function __wbg_maxTextureDimension2D_578c2c471b73bb60(arg0) {
    const ret = arg0.maxTextureDimension2D;
    return ret;
}
export function __wbg_maxTextureDimension3D_3532b309b08a5ddf(arg0) {
    const ret = arg0.maxTextureDimension3D;
    return ret;
}
export function __wbg_maxUniformBufferBindingSize_6c3b6b8424799146(arg0) {
    const ret = arg0.maxUniformBufferBindingSize;
    return ret;
}
export function __wbg_maxUniformBuffersPerShaderStage_911223507ba8d12a(arg0) {
    const ret = arg0.maxUniformBuffersPerShaderStage;
    return ret;
}
export function __wbg_maxVertexAttributes_399d9b947e980d08(arg0) {
    const ret = arg0.maxVertexAttributes;
    return ret;
}
export function __wbg_maxVertexBufferArrayStride_b5550ff3b3aa4a9e(arg0) {
    const ret = arg0.maxVertexBufferArrayStride;
    return ret;
}
export function __wbg_maxVertexBuffers_15be37c3f8fbfe0a(arg0) {
    const ret = arg0.maxVertexBuffers;
    return ret;
}
export function __wbg_message_e59c1a10ce6fce88(arg0, arg1) {
    const ret = arg1.message;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_minStorageBufferOffsetAlignment_5c389200e0be5fe1(arg0) {
    const ret = arg0.minStorageBufferOffsetAlignment;
    return ret;
}
export function __wbg_minUniformBufferOffsetAlignment_b9d974e659cd3e20(arg0) {
    const ret = arg0.minUniformBufferOffsetAlignment;
    return ret;
}
export function __wbg_navigator_a6aef662775ce236(arg0) {
    const ret = arg0.navigator;
    return ret;
}
export function __wbg_navigator_cda717510f3a4a47(arg0) {
    const ret = arg0.navigator;
    return ret;
}
export function __wbg_new_227d7c05414eb861() {
    const ret = new Error();
    return ret;
}
export function __wbg_new_4774b8d4db1224e4(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
}
export function __wbg_new_480195ddf7042529() {
    const ret = new Array();
    return ret;
}
export function __wbg_new_cc88e2b82fb56b5e() { return handleError(function (arg0, arg1) {
    const ret = new OffscreenCanvas(arg0 >>> 0, arg1 >>> 0);
    return ret;
}, arguments); }
export function __wbg_new_e4597c3f125a2038() {
    const ret = new Object();
    return ret;
}
export function __wbg_new_typed_5101eada2c6754de(arg0, arg1) {
    try {
        var state0 = {a: arg0, b: arg1};
        var cb0 = (arg0, arg1) => {
            const a = state0.a;
            state0.a = 0;
            try {
                return wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___js_sys_15d5b7dc83e46e31___Function_fn_wasm_bindgen_a15a00f74afbf033___JsValue_____wasm_bindgen_a15a00f74afbf033___sys__Undefined___js_sys_15d5b7dc83e46e31___Function_fn_wasm_bindgen_a15a00f74afbf033___JsValue_____wasm_bindgen_a15a00f74afbf033___sys__Undefined_______true_(a, state0.b, arg0, arg1);
            } finally {
                state0.a = a;
            }
        };
        const ret = new Promise(cb0);
        return ret;
    } finally {
        state0.a = 0;
    }
}
export function __wbg_new_with_byte_offset_and_length_716709b677573556(arg0, arg1, arg2) {
    const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
    return ret;
}
export function __wbg_new_with_length_7398e5e650b9da8d(arg0) {
    const ret = new Array(arg0 >>> 0);
    return ret;
}
export function __wbg_next_9a5990d0355cdd1a() { return handleError(function (arg0) {
    const ret = arg0.next();
    return ret;
}, arguments); }
export function __wbg_next_e75ce91d696d3c0f(arg0) {
    const ret = arg0.next;
    return ret;
}
export function __wbg_now_1925e14eb84a904c(arg0) {
    const ret = arg0.now();
    return ret;
}
export function __wbg_of_786b4c4fc6e0c8d8(arg0) {
    const ret = Array.of(arg0);
    return ret;
}
export function __wbg_onSubmittedWorkDone_81e152567230130a(arg0) {
    const ret = arg0.onSubmittedWorkDone();
    return ret;
}
export function __wbg_performance_6c4d39832e915483(arg0) {
    const ret = arg0.performance;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_pixelStorei_838f319e957b97b1(arg0, arg1, arg2) {
    arg0.pixelStorei(arg1 >>> 0, arg2);
}
export function __wbg_pixelStorei_f5aed17ba3a24523(arg0, arg1, arg2) {
    arg0.pixelStorei(arg1 >>> 0, arg2);
}
export function __wbg_polygonOffset_74e50db650460a2c(arg0, arg1, arg2) {
    arg0.polygonOffset(arg1, arg2);
}
export function __wbg_polygonOffset_7542e8fe4435f484(arg0, arg1, arg2) {
    arg0.polygonOffset(arg1, arg2);
}
export function __wbg_prototypesetcall_7dca54d31cb9d2dc(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_push_bb0def92a641d074(arg0, arg1) {
    const ret = arg0.push(arg1);
    return ret;
}
export function __wbg_queryCounterEXT_d666e8a0dfecf78f(arg0, arg1, arg2) {
    arg0.queryCounterEXT(arg1, arg2 >>> 0);
}
export function __wbg_querySelectorAll_8f983d85893fba25() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.querySelectorAll(getStringFromWasm0(arg1, arg2));
    return ret;
}, arguments); }
export function __wbg_querySelector_1fc4d5c8e75b125f() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.querySelector(getStringFromWasm0(arg1, arg2));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_queueMicrotask_1f50b4bdf2c98605(arg0) {
    queueMicrotask(arg0);
}
export function __wbg_queueMicrotask_805204511f79bee8(arg0) {
    const ret = arg0.queueMicrotask;
    return ret;
}
export function __wbg_queue_81f5d725809ccd54(arg0) {
    const ret = arg0.queue;
    return ret;
}
export function __wbg_readBuffer_272d64b66548e4bd(arg0, arg1) {
    arg0.readBuffer(arg1 >>> 0);
}
export function __wbg_readPixels_55677ecdb64ad211() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
    arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
}, arguments); }
export function __wbg_readPixels_ba0426af511e8a77() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
    arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
}, arguments); }
export function __wbg_readPixels_c001c684bc183eda() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
    arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
}, arguments); }
export function __wbg_renderbufferStorageMultisample_ded5bbc0de39e3df(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.renderbufferStorageMultisample(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
}
export function __wbg_renderbufferStorage_20bf5140a6a780c8(arg0, arg1, arg2, arg3, arg4) {
    arg0.renderbufferStorage(arg1 >>> 0, arg2 >>> 0, arg3, arg4);
}
export function __wbg_renderbufferStorage_4f355208808d8f99(arg0, arg1, arg2, arg3, arg4) {
    arg0.renderbufferStorage(arg1 >>> 0, arg2 >>> 0, arg3, arg4);
}
export function __wbg_requestAdapter_90f7496e67f82c21(arg0, arg1) {
    const ret = arg0.requestAdapter(arg1);
    return ret;
}
export function __wbg_requestAdapter_fc75ea09f9702080(arg0) {
    const ret = arg0.requestAdapter();
    return ret;
}
export function __wbg_requestDevice_5c307ce72228d3f7(arg0, arg1) {
    const ret = arg0.requestDevice(arg1);
    return ret;
}
export function __wbg_resolve_bb4df27803d377b2(arg0) {
    const ret = Promise.resolve(arg0);
    return ret;
}
export function __wbg_samplerParameterf_06875ad911bc519e(arg0, arg1, arg2, arg3) {
    arg0.samplerParameterf(arg1, arg2 >>> 0, arg3);
}
export function __wbg_samplerParameteri_4af53d9fc7d25a07(arg0, arg1, arg2, arg3) {
    arg0.samplerParameteri(arg1, arg2 >>> 0, arg3);
}
export function __wbg_scissor_6505f3843445d107(arg0, arg1, arg2, arg3, arg4) {
    arg0.scissor(arg1, arg2, arg3, arg4);
}
export function __wbg_scissor_8005f47af2354125(arg0, arg1, arg2, arg3, arg4) {
    arg0.scissor(arg1, arg2, arg3, arg4);
}
export function __wbg_setBindGroup_58960c4b1bcdd182(arg0, arg1, arg2) {
    arg0.setBindGroup(arg1 >>> 0, arg2);
}
export function __wbg_setBindGroup_a62f9de1cb2449b2() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.setBindGroup(arg1 >>> 0, arg2, getArrayU32FromWasm0(arg3, arg4), arg5, arg6 >>> 0);
}, arguments); }
export function __wbg_setPipeline_9f6b0a3c5901572d(arg0, arg1) {
    arg0.setPipeline(arg1);
}
export function __wbg_setVertexBuffer_c3bb3670263af952(arg0, arg1, arg2, arg3, arg4) {
    arg0.setVertexBuffer(arg1 >>> 0, arg2, arg3, arg4);
}
export function __wbg_setVertexBuffer_c3c88170005afc1b(arg0, arg1, arg2, arg3) {
    arg0.setVertexBuffer(arg1 >>> 0, arg2, arg3);
}
export function __wbg_set_05b085c909633819() { return handleError(function (arg0, arg1, arg2) {
    const ret = Reflect.set(arg0, arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_set_311d3efbf4bfd23f(arg0, arg1, arg2) {
    arg0.set(arg1, arg2 >>> 0);
}
export function __wbg_set_a_2f4495829c853bba(arg0, arg1) {
    arg0.a = arg1;
}
export function __wbg_set_access_802ef755476d4064(arg0, arg1) {
    arg0.access = __wbindgen_enum_GpuStorageTextureAccess[arg1];
}
export function __wbg_set_address_mode_u_c13cdf94d097b16d(arg0, arg1) {
    arg0.addressModeU = __wbindgen_enum_GpuAddressMode[arg1];
}
export function __wbg_set_address_mode_v_c09db9861cd052a6(arg0, arg1) {
    arg0.addressModeV = __wbindgen_enum_GpuAddressMode[arg1];
}
export function __wbg_set_address_mode_w_0b49c35f3d4322bf(arg0, arg1) {
    arg0.addressModeW = __wbindgen_enum_GpuAddressMode[arg1];
}
export function __wbg_set_alpha_29642d2219224544(arg0, arg1) {
    arg0.alpha = arg1;
}
export function __wbg_set_alpha_mode_65ba0adaef90e1f3(arg0, arg1) {
    arg0.alphaMode = __wbindgen_enum_GpuCanvasAlphaMode[arg1];
}
export function __wbg_set_alpha_to_coverage_enabled_ab6a22e18e338493(arg0, arg1) {
    arg0.alphaToCoverageEnabled = arg1 !== 0;
}
export function __wbg_set_array_layer_count_de83f575c3f6d15e(arg0, arg1) {
    arg0.arrayLayerCount = arg1 >>> 0;
}
export function __wbg_set_array_stride_2033aeb8a42130f9(arg0, arg1) {
    arg0.arrayStride = arg1;
}
export function __wbg_set_aspect_4c0237c8f21de349(arg0, arg1) {
    arg0.aspect = __wbindgen_enum_GpuTextureAspect[arg1];
}
export function __wbg_set_aspect_adde591ce42eb208(arg0, arg1) {
    arg0.aspect = __wbindgen_enum_GpuTextureAspect[arg1];
}
export function __wbg_set_aspect_feb0fac859e82372(arg0, arg1) {
    arg0.aspect = __wbindgen_enum_GpuTextureAspect[arg1];
}
export function __wbg_set_attributes_39e5a71bf05309a6(arg0, arg1) {
    arg0.attributes = arg1;
}
export function __wbg_set_b_7081554879455e65(arg0, arg1) {
    arg0.b = arg1;
}
export function __wbg_set_base_array_layer_ab196aad24c8fac6(arg0, arg1) {
    arg0.baseArrayLayer = arg1 >>> 0;
}
export function __wbg_set_base_mip_level_15d29fc182e25a82(arg0, arg1) {
    arg0.baseMipLevel = arg1 >>> 0;
}
export function __wbg_set_beginning_of_pass_write_index_c2f97408798615ca(arg0, arg1) {
    arg0.beginningOfPassWriteIndex = arg1 >>> 0;
}
export function __wbg_set_bind_group_layouts_5c298441f47e30a1(arg0, arg1) {
    arg0.bindGroupLayouts = arg1;
}
export function __wbg_set_binding_234b4c508d19a0a8(arg0, arg1) {
    arg0.binding = arg1 >>> 0;
}
export function __wbg_set_binding_fd933455b600a07f(arg0, arg1) {
    arg0.binding = arg1 >>> 0;
}
export function __wbg_set_blend_1dbdd086fc4fdebf(arg0, arg1) {
    arg0.blend = arg1;
}
export function __wbg_set_buffer_8f0ef5be1b92d605(arg0, arg1) {
    arg0.buffer = arg1;
}
export function __wbg_set_buffer_b04e4d70b1eb4630(arg0, arg1) {
    arg0.buffer = arg1;
}
export function __wbg_set_buffers_3f9c487ea01dddcf(arg0, arg1) {
    arg0.buffers = arg1;
}
export function __wbg_set_bytes_per_row_39bcca8e0c25e0ee(arg0, arg1) {
    arg0.bytesPerRow = arg1 >>> 0;
}
export function __wbg_set_c78f0ccf7c3f53b7(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
}
export function __wbg_set_clear_value_1663cbe7da00e7e4(arg0, arg1) {
    arg0.clearValue = arg1;
}
export function __wbg_set_code_3bb44fc02aa17153(arg0, arg1, arg2) {
    arg0.code = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_color_attachments_b740d060dacde5c0(arg0, arg1) {
    arg0.colorAttachments = arg1;
}
export function __wbg_set_color_d0208d092af4f2e6(arg0, arg1) {
    arg0.color = arg1;
}
export function __wbg_set_compare_00dc33383c873ad5(arg0, arg1) {
    arg0.compare = __wbindgen_enum_GpuCompareFunction[arg1];
}
export function __wbg_set_compare_11834994f7d75687(arg0, arg1) {
    arg0.compare = __wbindgen_enum_GpuCompareFunction[arg1];
}
export function __wbg_set_count_ab42cbc78635ed91(arg0, arg1) {
    arg0.count = arg1 >>> 0;
}
export function __wbg_set_cull_mode_c4f1ef740bd14c40(arg0, arg1) {
    arg0.cullMode = __wbindgen_enum_GpuCullMode[arg1];
}
export function __wbg_set_depth_bias_clamp_f573c2dda55692a6(arg0, arg1) {
    arg0.depthBiasClamp = arg1;
}
export function __wbg_set_depth_bias_ebe05aecbb98e11f(arg0, arg1) {
    arg0.depthBias = arg1;
}
export function __wbg_set_depth_bias_slope_scale_27c8208740c46086(arg0, arg1) {
    arg0.depthBiasSlopeScale = arg1;
}
export function __wbg_set_depth_clear_value_57c2283d39fbb181(arg0, arg1) {
    arg0.depthClearValue = arg1;
}
export function __wbg_set_depth_compare_a9c538cec0e01535(arg0, arg1) {
    arg0.depthCompare = __wbindgen_enum_GpuCompareFunction[arg1];
}
export function __wbg_set_depth_fail_op_42b9d46a7c67baae(arg0, arg1) {
    arg0.depthFailOp = __wbindgen_enum_GpuStencilOperation[arg1];
}
export function __wbg_set_depth_load_op_f95fdb158b819261(arg0, arg1) {
    arg0.depthLoadOp = __wbindgen_enum_GpuLoadOp[arg1];
}
export function __wbg_set_depth_or_array_layers_7335d3fc04cd5ade(arg0, arg1) {
    arg0.depthOrArrayLayers = arg1 >>> 0;
}
export function __wbg_set_depth_read_only_878b741b02a4dd71(arg0, arg1) {
    arg0.depthReadOnly = arg1 !== 0;
}
export function __wbg_set_depth_stencil_1c7bed669574dd1e(arg0, arg1) {
    arg0.depthStencil = arg1;
}
export function __wbg_set_depth_stencil_attachment_82ce8924f4e0e79b(arg0, arg1) {
    arg0.depthStencilAttachment = arg1;
}
export function __wbg_set_depth_store_op_4c56ab1d005c7bf6(arg0, arg1) {
    arg0.depthStoreOp = __wbindgen_enum_GpuStoreOp[arg1];
}
export function __wbg_set_depth_write_enabled_f726d4f27a24ff7e(arg0, arg1) {
    arg0.depthWriteEnabled = arg1 !== 0;
}
export function __wbg_set_device_f991f8a955db69f7(arg0, arg1) {
    arg0.device = arg1;
}
export function __wbg_set_dimension_7ca3d24380d365e4(arg0, arg1) {
    arg0.dimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
}
export function __wbg_set_dimension_87dd70a08e54ea98(arg0, arg1) {
    arg0.dimension = __wbindgen_enum_GpuTextureDimension[arg1];
}
export function __wbg_set_dst_factor_1382684d97e2aec4(arg0, arg1) {
    arg0.dstFactor = __wbindgen_enum_GpuBlendFactor[arg1];
}
export function __wbg_set_end_of_pass_write_index_3476a9a4411846af(arg0, arg1) {
    arg0.endOfPassWriteIndex = arg1 >>> 0;
}
export function __wbg_set_entries_44ee8dc60918063d(arg0, arg1) {
    arg0.entries = arg1;
}
export function __wbg_set_entries_803b89386febf57c(arg0, arg1) {
    arg0.entries = arg1;
}
export function __wbg_set_entry_point_418e5aecbf7f95b4(arg0, arg1, arg2) {
    arg0.entryPoint = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_entry_point_ac45ddee35909233(arg0, arg1, arg2) {
    arg0.entryPoint = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_external_texture_73d5e5303574a1e8(arg0, arg1) {
    arg0.externalTexture = arg1;
}
export function __wbg_set_fail_op_6f4612035f584d02(arg0, arg1) {
    arg0.failOp = __wbindgen_enum_GpuStencilOperation[arg1];
}
export function __wbg_set_flip_y_21c0cdab245f4d89(arg0, arg1) {
    arg0.flipY = arg1 !== 0;
}
export function __wbg_set_format_2bd90cb220cc6884(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_3cc5d6ead9a8cce0(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_40d793124494a9df(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_723d6bb38a9e71d3(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuVertexFormat[arg1];
}
export function __wbg_set_format_c23f7c142762c3a7(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_e0af83ab86ee58dc(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_format_fcbaa54d6b5c186a(arg0, arg1) {
    arg0.format = __wbindgen_enum_GpuTextureFormat[arg1];
}
export function __wbg_set_fragment_9b5673b1b740fe0e(arg0, arg1) {
    arg0.fragment = arg1;
}
export function __wbg_set_front_face_bb590812353fd2e0(arg0, arg1) {
    arg0.frontFace = __wbindgen_enum_GpuFrontFace[arg1];
}
export function __wbg_set_g_aa23517844bd7f61(arg0, arg1) {
    arg0.g = arg1;
}
export function __wbg_set_has_dynamic_offset_ea1fb6bd94b0c904(arg0, arg1) {
    arg0.hasDynamicOffset = arg1 !== 0;
}
export function __wbg_set_height_2a52d80e749439c5(arg0, arg1) {
    arg0.height = arg1 >>> 0;
}
export function __wbg_set_height_66583e77881d3a51(arg0, arg1) {
    arg0.height = arg1 >>> 0;
}
export function __wbg_set_height_9a5b963336a79877(arg0, arg1) {
    arg0.height = arg1 >>> 0;
}
export function __wbg_set_label_08e9f27a97fdc9f7(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_0e9f90ea4e961823(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_280bd57b618e4cf6(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_34d2766c2203f76a(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_4bf9f5458cdc0a68(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_797345a8c9c86146(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_8fdd5f28eea3ca08(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_a4be4acc3510c62f(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_bb92451e0d92abf4(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_c3405868bd8f6ab5(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_d73358f96a62d3bc(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_f00eb249a34df7db(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_label_f571593aaa82f18b(arg0, arg1, arg2) {
    arg0.label = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_layout_9590b02a1d72ac45(arg0, arg1) {
    arg0.layout = arg1;
}
export function __wbg_set_layout_a065a939d1d05a2d(arg0, arg1) {
    arg0.layout = arg1;
}
export function __wbg_set_load_op_07c59d4ab60a3a01(arg0, arg1) {
    arg0.loadOp = __wbindgen_enum_GpuLoadOp[arg1];
}
export function __wbg_set_lod_max_clamp_fd1548dc78538913(arg0, arg1) {
    arg0.lodMaxClamp = arg1;
}
export function __wbg_set_lod_min_clamp_b489016289e378d2(arg0, arg1) {
    arg0.lodMinClamp = arg1;
}
export function __wbg_set_mag_filter_b4e8d7f2fa665d2e(arg0, arg1) {
    arg0.magFilter = __wbindgen_enum_GpuFilterMode[arg1];
}
export function __wbg_set_mapped_at_creation_c78869832c67816c(arg0, arg1) {
    arg0.mappedAtCreation = arg1 !== 0;
}
export function __wbg_set_mask_cee9de29cbe61459(arg0, arg1) {
    arg0.mask = arg1 >>> 0;
}
export function __wbg_set_max_anisotropy_a019fd38d9ba634e(arg0, arg1) {
    arg0.maxAnisotropy = arg1;
}
export function __wbg_set_min_binding_size_26f877007450686c(arg0, arg1) {
    arg0.minBindingSize = arg1;
}
export function __wbg_set_min_filter_cd8cf3dcdeebaa5b(arg0, arg1) {
    arg0.minFilter = __wbindgen_enum_GpuFilterMode[arg1];
}
export function __wbg_set_mip_level_161666aedb691ca3(arg0, arg1) {
    arg0.mipLevel = arg1 >>> 0;
}
export function __wbg_set_mip_level_count_1993f039035d2469(arg0, arg1) {
    arg0.mipLevelCount = arg1 >>> 0;
}
export function __wbg_set_mip_level_count_9a86e098393fe360(arg0, arg1) {
    arg0.mipLevelCount = arg1 >>> 0;
}
export function __wbg_set_mip_level_e61d3964c419f64b(arg0, arg1) {
    arg0.mipLevel = arg1 >>> 0;
}
export function __wbg_set_mipmap_filter_a436d61249cfa785(arg0, arg1) {
    arg0.mipmapFilter = __wbindgen_enum_GpuMipmapFilterMode[arg1];
}
export function __wbg_set_module_951f2b6e5477a260(arg0, arg1) {
    arg0.module = arg1;
}
export function __wbg_set_module_a7b3448454ca8879(arg0, arg1) {
    arg0.module = arg1;
}
export function __wbg_set_multisample_bb6537e862d91237(arg0, arg1) {
    arg0.multisample = arg1;
}
export function __wbg_set_multisampled_9642e942e4d9d3ee(arg0, arg1) {
    arg0.multisampled = arg1 !== 0;
}
export function __wbg_set_offset_3e55dd16ffd7aac5(arg0, arg1) {
    arg0.offset = arg1;
}
export function __wbg_set_offset_a3a60cec10207186(arg0, arg1) {
    arg0.offset = arg1;
}
export function __wbg_set_offset_debfe602a5fbf272(arg0, arg1) {
    arg0.offset = arg1;
}
export function __wbg_set_onuncapturederror_8f485d34a545d58b(arg0, arg1) {
    arg0.onuncapturederror = arg1;
}
export function __wbg_set_operation_74a529d361734388(arg0, arg1) {
    arg0.operation = __wbindgen_enum_GpuBlendOperation[arg1];
}
export function __wbg_set_origin_42cf0cf261f50d63(arg0, arg1) {
    arg0.origin = arg1;
}
export function __wbg_set_origin_d09654f499e9edb8(arg0, arg1) {
    arg0.origin = arg1;
}
export function __wbg_set_origin_f7a8894367b28556(arg0, arg1) {
    arg0.origin = arg1;
}
export function __wbg_set_pass_op_8abd39478c76666a(arg0, arg1) {
    arg0.passOp = __wbindgen_enum_GpuStencilOperation[arg1];
}
export function __wbg_set_power_preference_b8b4ea5da6674cf7(arg0, arg1) {
    arg0.powerPreference = __wbindgen_enum_GpuPowerPreference[arg1];
}
export function __wbg_set_premultiplied_alpha_dde44b27abcf88fc(arg0, arg1) {
    arg0.premultipliedAlpha = arg1 !== 0;
}
export function __wbg_set_primitive_f189fcdcb22d09e0(arg0, arg1) {
    arg0.primitive = arg1;
}
export function __wbg_set_query_set_dcf406a51ece8f85(arg0, arg1) {
    arg0.querySet = arg1;
}
export function __wbg_set_r_8961014434a7656e(arg0, arg1) {
    arg0.r = arg1;
}
export function __wbg_set_required_features_ec67124fd26c4d29(arg0, arg1) {
    arg0.requiredFeatures = arg1;
}
export function __wbg_set_required_limits_c9ee7006f1d1f2ab(arg0, arg1) {
    arg0.requiredLimits = arg1;
}
export function __wbg_set_resolve_target_cc7a6f0d2973ea34(arg0, arg1) {
    arg0.resolveTarget = arg1;
}
export function __wbg_set_resource_86645e7515651c0e(arg0, arg1) {
    arg0.resource = arg1;
}
export function __wbg_set_rows_per_image_7203b6e2d244a111(arg0, arg1) {
    arg0.rowsPerImage = arg1 >>> 0;
}
export function __wbg_set_sample_count_4d7160817d98838f(arg0, arg1) {
    arg0.sampleCount = arg1 >>> 0;
}
export function __wbg_set_sample_type_8d4d5b141ce0f724(arg0, arg1) {
    arg0.sampleType = __wbindgen_enum_GpuTextureSampleType[arg1];
}
export function __wbg_set_sampler_35bcbac78bd4356f(arg0, arg1) {
    arg0.sampler = arg1;
}
export function __wbg_set_shader_location_3ce5152f6d464a63(arg0, arg1) {
    arg0.shaderLocation = arg1 >>> 0;
}
export function __wbg_set_size_81a77f7f4f34fbed(arg0, arg1) {
    arg0.size = arg1;
}
export function __wbg_set_size_85cb1c2c4c3ea73a(arg0, arg1) {
    arg0.size = arg1;
}
export function __wbg_set_size_981550e5d7941340(arg0, arg1) {
    arg0.size = arg1;
}
export function __wbg_set_source_51577a2cebeadf81(arg0, arg1) {
    arg0.source = arg1;
}
export function __wbg_set_src_factor_9a8e0943a05c9174(arg0, arg1) {
    arg0.srcFactor = __wbindgen_enum_GpuBlendFactor[arg1];
}
export function __wbg_set_stencil_back_596ea9628419413d(arg0, arg1) {
    arg0.stencilBack = arg1;
}
export function __wbg_set_stencil_clear_value_15afeb03c22cd51d(arg0, arg1) {
    arg0.stencilClearValue = arg1 >>> 0;
}
export function __wbg_set_stencil_front_31be994e05be5aaa(arg0, arg1) {
    arg0.stencilFront = arg1;
}
export function __wbg_set_stencil_load_op_1cd94e9e8c54f611(arg0, arg1) {
    arg0.stencilLoadOp = __wbindgen_enum_GpuLoadOp[arg1];
}
export function __wbg_set_stencil_read_mask_1635f30a0e6539e3(arg0, arg1) {
    arg0.stencilReadMask = arg1 >>> 0;
}
export function __wbg_set_stencil_read_only_f071431988182ad8(arg0, arg1) {
    arg0.stencilReadOnly = arg1 !== 0;
}
export function __wbg_set_stencil_store_op_a244d5347f386c8c(arg0, arg1) {
    arg0.stencilStoreOp = __wbindgen_enum_GpuStoreOp[arg1];
}
export function __wbg_set_stencil_write_mask_7809f82a1debe58f(arg0, arg1) {
    arg0.stencilWriteMask = arg1 >>> 0;
}
export function __wbg_set_step_mode_eb762c8c4264418f(arg0, arg1) {
    arg0.stepMode = __wbindgen_enum_GpuVertexStepMode[arg1];
}
export function __wbg_set_storage_texture_22f78b5171d1195a(arg0, arg1) {
    arg0.storageTexture = arg1;
}
export function __wbg_set_store_op_386596acc7bf2c16(arg0, arg1) {
    arg0.storeOp = __wbindgen_enum_GpuStoreOp[arg1];
}
export function __wbg_set_strip_index_format_e76748cd840ab562(arg0, arg1) {
    arg0.stripIndexFormat = __wbindgen_enum_GpuIndexFormat[arg1];
}
export function __wbg_set_targets_22473476afe0dabd(arg0, arg1) {
    arg0.targets = arg1;
}
export function __wbg_set_texture_2c34d28ab9666948(arg0, arg1) {
    arg0.texture = arg1;
}
export function __wbg_set_texture_ac9a46252c0cb532(arg0, arg1) {
    arg0.texture = arg1;
}
export function __wbg_set_texture_aeea930400349204(arg0, arg1) {
    arg0.texture = arg1;
}
export function __wbg_set_timestamp_writes_0236dfc7ae2b1a03(arg0, arg1) {
    arg0.timestampWrites = arg1;
}
export function __wbg_set_topology_e18a15a717ebc912(arg0, arg1) {
    arg0.topology = __wbindgen_enum_GpuPrimitiveTopology[arg1];
}
export function __wbg_set_type_31b1662dd5a6144d(arg0, arg1) {
    arg0.type = __wbindgen_enum_GpuSamplerBindingType[arg1];
}
export function __wbg_set_type_719f40cf36d314f1(arg0, arg1) {
    arg0.type = __wbindgen_enum_GpuBufferBindingType[arg1];
}
export function __wbg_set_unclipped_depth_0f5d142d317e3a7c(arg0, arg1) {
    arg0.unclippedDepth = arg1 !== 0;
}
export function __wbg_set_usage_26861a639595cd45(arg0, arg1) {
    arg0.usage = arg1 >>> 0;
}
export function __wbg_set_usage_7b79a227ada2f5cc(arg0, arg1) {
    arg0.usage = arg1 >>> 0;
}
export function __wbg_set_usage_d9ff4b7757fac246(arg0, arg1) {
    arg0.usage = arg1 >>> 0;
}
export function __wbg_set_usage_e8d45decd5c483b3(arg0, arg1) {
    arg0.usage = arg1 >>> 0;
}
export function __wbg_set_vertex_b95705590b782671(arg0, arg1) {
    arg0.vertex = arg1;
}
export function __wbg_set_view_6ff951d6e3f9e337(arg0, arg1) {
    arg0.view = arg1;
}
export function __wbg_set_view_cf298e1e7b6ef38a(arg0, arg1) {
    arg0.view = arg1;
}
export function __wbg_set_view_dimension_87c95b0d987a14cd(arg0, arg1) {
    arg0.viewDimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
}
export function __wbg_set_view_dimension_e99ec138da7b8f83(arg0, arg1) {
    arg0.viewDimension = __wbindgen_enum_GpuTextureViewDimension[arg1];
}
export function __wbg_set_view_formats_733fb624c2f2ef6b(arg0, arg1) {
    arg0.viewFormats = arg1;
}
export function __wbg_set_view_formats_c2b27891ca5d2740(arg0, arg1) {
    arg0.viewFormats = arg1;
}
export function __wbg_set_visibility_315bcac6427d0ba0(arg0, arg1) {
    arg0.visibility = arg1 >>> 0;
}
export function __wbg_set_width_63034f88f9905ea3(arg0, arg1) {
    arg0.width = arg1 >>> 0;
}
export function __wbg_set_width_913f2db354db9600(arg0, arg1) {
    arg0.width = arg1 >>> 0;
}
export function __wbg_set_width_d8263652df911d1d(arg0, arg1) {
    arg0.width = arg1 >>> 0;
}
export function __wbg_set_write_mask_0b6ca0cb1b797997(arg0, arg1) {
    arg0.writeMask = arg1 >>> 0;
}
export function __wbg_set_x_0b48c73e72f71653(arg0, arg1) {
    arg0.x = arg1 >>> 0;
}
export function __wbg_set_x_ffcb360b171098d5(arg0, arg1) {
    arg0.x = arg1 >>> 0;
}
export function __wbg_set_y_046a6a6e9b0ccbc6(arg0, arg1) {
    arg0.y = arg1 >>> 0;
}
export function __wbg_set_y_db82e366feb18537(arg0, arg1) {
    arg0.y = arg1 >>> 0;
}
export function __wbg_set_z_cec02b76fd208d0e(arg0, arg1) {
    arg0.z = arg1 >>> 0;
}
export function __wbg_shaderSource_0a7551b1ac04be73(arg0, arg1, arg2, arg3) {
    arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
}
export function __wbg_shaderSource_20cc64d9735c296d(arg0, arg1, arg2, arg3) {
    arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
}
export function __wbg_stack_3b0d974bbf31e44f(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_static_accessor_GLOBAL_44bef9fa6011e260() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_GLOBAL_THIS_13002645baf43d84() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_SELF_91d0abd4d035416c() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_WINDOW_513f857c65724fc7() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_stencilFuncSeparate_a5aa44ea4cd6e6ba(arg0, arg1, arg2, arg3, arg4) {
    arg0.stencilFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
}
export function __wbg_stencilFuncSeparate_cd1e7d14d8dd596e(arg0, arg1, arg2, arg3, arg4) {
    arg0.stencilFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
}
export function __wbg_stencilMaskSeparate_cf1c2440e82312dd(arg0, arg1, arg2) {
    arg0.stencilMaskSeparate(arg1 >>> 0, arg2 >>> 0);
}
export function __wbg_stencilMaskSeparate_d2e3112d57a20f9c(arg0, arg1, arg2) {
    arg0.stencilMaskSeparate(arg1 >>> 0, arg2 >>> 0);
}
export function __wbg_stencilMask_45135bee9873f8e2(arg0, arg1) {
    arg0.stencilMask(arg1 >>> 0);
}
export function __wbg_stencilMask_a4e7a1a4b471aae5(arg0, arg1) {
    arg0.stencilMask(arg1 >>> 0);
}
export function __wbg_stencilOpSeparate_32ee0d9adb3e45e6(arg0, arg1, arg2, arg3, arg4) {
    arg0.stencilOpSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
}
export function __wbg_stencilOpSeparate_654ae73b54c22938(arg0, arg1, arg2, arg3, arg4) {
    arg0.stencilOpSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
}
export function __wbg_submit_f39583470d95df20(arg0, arg1) {
    arg0.submit(arg1);
}
export function __wbg_texImage2D_795f9dff0fd9f8fe() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texImage2D_88a8191aa5c3d7bb() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texImage2D_e8b9f50a2836a005() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texImage3D_2e97b9400c1fa848() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
    arg0.texImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8 >>> 0, arg9 >>> 0, arg10);
}, arguments); }
export function __wbg_texImage3D_c1d29edf43dca980() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
    arg0.texImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8 >>> 0, arg9 >>> 0, arg10);
}, arguments); }
export function __wbg_texParameteri_1d5f90924850bc7e(arg0, arg1, arg2, arg3) {
    arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
}
export function __wbg_texParameteri_2f60d62df693455a(arg0, arg1, arg2, arg3) {
    arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
}
export function __wbg_texStorage2D_4df7279c6b585e48(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.texStorage2D(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
}
export function __wbg_texStorage3D_ff0826b2a2cf6d6f(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.texStorage3D(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5, arg6);
}
export function __wbg_texSubImage2D_07b82087117be55c() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texSubImage2D_12b54c380b70c677() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texSubImage2D_17e3e55f6593f187() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texSubImage2D_256097e8c70c742d() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texSubImage2D_2a4269641c94bb9a() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texSubImage2D_56b8216178007d73() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texSubImage2D_8be481783b3f22eb() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texSubImage2D_8d992d1161c1c3fe() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
}, arguments); }
export function __wbg_texSubImage3D_154d5c67f1bf984e() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
}, arguments); }
export function __wbg_texSubImage3D_305d1245292e3d56() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
}, arguments); }
export function __wbg_texSubImage3D_6162cf78b50b8ff1() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
}, arguments); }
export function __wbg_texSubImage3D_7ad3e794fec3fe31() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
}, arguments); }
export function __wbg_texSubImage3D_a174690abf2066a1() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
}, arguments); }
export function __wbg_texSubImage3D_b05d9b6b481231e8() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
}, arguments); }
export function __wbg_texSubImage3D_ed53bff13f8fab20() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
    arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
}, arguments); }
export function __wbg_then_34956fdd88b794f7(arg0, arg1, arg2) {
    const ret = arg0.then(arg1, arg2);
    return ret;
}
export function __wbg_then_d9ebfadd74ddfbb2(arg0, arg1) {
    const ret = arg0.then(arg1);
    return ret;
}
export function __wbg_then_f6dedb0d880db23a(arg0, arg1, arg2) {
    const ret = arg0.then(arg1, arg2);
    return ret;
}
export function __wbg_uniform1f_1c377b51535d0d1f(arg0, arg1, arg2) {
    arg0.uniform1f(arg1, arg2);
}
export function __wbg_uniform1f_c490c66e9b895aae(arg0, arg1, arg2) {
    arg0.uniform1f(arg1, arg2);
}
export function __wbg_uniform1i_017af453f51246d1(arg0, arg1, arg2) {
    arg0.uniform1i(arg1, arg2);
}
export function __wbg_uniform1i_620429c56da52252(arg0, arg1, arg2) {
    arg0.uniform1i(arg1, arg2);
}
export function __wbg_uniform1ui_155d89c092153aa2(arg0, arg1, arg2) {
    arg0.uniform1ui(arg1, arg2 >>> 0);
}
export function __wbg_uniform2fv_1db51f6084ad6abc(arg0, arg1, arg2, arg3) {
    arg0.uniform2fv(arg1, getArrayF32FromWasm0(arg2, arg3));
}
export function __wbg_uniform2fv_95eba8de1a75316c(arg0, arg1, arg2, arg3) {
    arg0.uniform2fv(arg1, getArrayF32FromWasm0(arg2, arg3));
}
export function __wbg_uniform2iv_5cf511c784bb896d(arg0, arg1, arg2, arg3) {
    arg0.uniform2iv(arg1, getArrayI32FromWasm0(arg2, arg3));
}
export function __wbg_uniform2iv_84e3c725bd528b8a(arg0, arg1, arg2, arg3) {
    arg0.uniform2iv(arg1, getArrayI32FromWasm0(arg2, arg3));
}
export function __wbg_uniform2uiv_725f0512d37bf556(arg0, arg1, arg2, arg3) {
    arg0.uniform2uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
}
export function __wbg_uniform3fv_86a178cb652f2b7b(arg0, arg1, arg2, arg3) {
    arg0.uniform3fv(arg1, getArrayF32FromWasm0(arg2, arg3));
}
export function __wbg_uniform3fv_ea1cef2226b3690b(arg0, arg1, arg2, arg3) {
    arg0.uniform3fv(arg1, getArrayF32FromWasm0(arg2, arg3));
}
export function __wbg_uniform3iv_b4765f8639ffbc25(arg0, arg1, arg2, arg3) {
    arg0.uniform3iv(arg1, getArrayI32FromWasm0(arg2, arg3));
}
export function __wbg_uniform3iv_fa6a96468c0c1b19(arg0, arg1, arg2, arg3) {
    arg0.uniform3iv(arg1, getArrayI32FromWasm0(arg2, arg3));
}
export function __wbg_uniform3uiv_c7fafdccbda533a8(arg0, arg1, arg2, arg3) {
    arg0.uniform3uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
}
export function __wbg_uniform4f_28eae6dcd90747ef(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.uniform4f(arg1, arg2, arg3, arg4, arg5);
}
export function __wbg_uniform4f_fa57294d7e814443(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.uniform4f(arg1, arg2, arg3, arg4, arg5);
}
export function __wbg_uniform4fv_5bf113e98e85870c(arg0, arg1, arg2, arg3) {
    arg0.uniform4fv(arg1, getArrayF32FromWasm0(arg2, arg3));
}
export function __wbg_uniform4fv_74b5bf22f0b64068(arg0, arg1, arg2, arg3) {
    arg0.uniform4fv(arg1, getArrayF32FromWasm0(arg2, arg3));
}
export function __wbg_uniform4iv_b1cccf4a989f9766(arg0, arg1, arg2, arg3) {
    arg0.uniform4iv(arg1, getArrayI32FromWasm0(arg2, arg3));
}
export function __wbg_uniform4iv_b1ec17c546329cf7(arg0, arg1, arg2, arg3) {
    arg0.uniform4iv(arg1, getArrayI32FromWasm0(arg2, arg3));
}
export function __wbg_uniform4uiv_32dbcdf1d62f1335(arg0, arg1, arg2, arg3) {
    arg0.uniform4uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
}
export function __wbg_uniformBlockBinding_29150fa1f063c3ce(arg0, arg1, arg2, arg3) {
    arg0.uniformBlockBinding(arg1, arg2 >>> 0, arg3 >>> 0);
}
export function __wbg_uniformMatrix2fv_9058d5464302984f(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix2fv_b0feb90ab800c7f2(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix2x3fv_3d5f4732af0e8f7d(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix2x3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix2x4fv_ed9873fa3c163c6e(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix2x4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix3fv_28106571f00b15e4(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix3fv_afb1c2aac27851c3(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix3x2fv_7ab78a7f575bb7de(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix3x2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix3x4fv_d66820527e5f0045(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix3x4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix4fv_919ea0c0b6fe355f(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix4fv_f1e046c5f61ed71f(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix4x2fv_39f3d5afb850dfc2(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix4x2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_uniformMatrix4x3fv_a53a6e2b38fde6ba(arg0, arg1, arg2, arg3, arg4) {
    arg0.uniformMatrix4x3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
}
export function __wbg_unmap_9455a68932e9b935(arg0) {
    arg0.unmap();
}
export function __wbg_useProgram_a229a93fc78688ee(arg0, arg1) {
    arg0.useProgram(arg1);
}
export function __wbg_useProgram_eec93ec68983b282(arg0, arg1) {
    arg0.useProgram(arg1);
}
export function __wbg_valueOf_e60ac14be76f5cd9(arg0) {
    const ret = arg0.valueOf();
    return ret;
}
export function __wbg_value_8996dd08e99f9529(arg0) {
    const ret = arg0.value;
    return ret;
}
export function __wbg_vertexAttribDivisorANGLE_b82130b5be2899a8(arg0, arg1, arg2) {
    arg0.vertexAttribDivisorANGLE(arg1 >>> 0, arg2 >>> 0);
}
export function __wbg_vertexAttribDivisor_61b2b06e68a18d7e(arg0, arg1, arg2) {
    arg0.vertexAttribDivisor(arg1 >>> 0, arg2 >>> 0);
}
export function __wbg_vertexAttribIPointer_149075befb883e06(arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.vertexAttribIPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
}
export function __wbg_vertexAttribPointer_72351aab9dc93e2c(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
}
export function __wbg_vertexAttribPointer_ef3fe0b7841ec062(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
}
export function __wbg_videoHeight_5b83e795d426af87(arg0) {
    const ret = arg0.videoHeight;
    return ret;
}
export function __wbg_videoWidth_0b0534d00ec8f243(arg0) {
    const ret = arg0.videoWidth;
    return ret;
}
export function __wbg_viewport_1031753073d031a2(arg0, arg1, arg2, arg3, arg4) {
    arg0.viewport(arg1, arg2, arg3, arg4);
}
export function __wbg_viewport_94c85b86d76f49a7(arg0, arg1, arg2, arg3, arg4) {
    arg0.viewport(arg1, arg2, arg3, arg4);
}
export function __wbg_width_1b4013dc9b9b69b2(arg0) {
    const ret = arg0.width;
    return ret;
}
export function __wbg_width_2f2313f535ecc2de(arg0) {
    const ret = arg0.width;
    return ret;
}
export function __wbg_width_7d707333391e14ff(arg0) {
    const ret = arg0.width;
    return ret;
}
export function __wbg_width_c387004ab78e7a13(arg0) {
    const ret = arg0.width;
    return ret;
}
export function __wbg_width_d1eed72b8d2ae405(arg0) {
    const ret = arg0.width;
    return ret;
}
export function __wbg_writeBuffer_2384abff9a0faef7() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.writeBuffer(arg1, arg2, getArrayU8FromWasm0(arg3, arg4), arg5, arg6);
}, arguments); }
export function __wbg_writeTexture_d42ce6ec94b2c6ca() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
    arg0.writeTexture(arg1, getArrayU8FromWasm0(arg2, arg3), arg4, arg5);
}, arguments); }
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 2545, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_a15a00f74afbf033___JsError___true_);
    return ret;
}
export function __wbindgen_cast_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 796, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue______true_);
    return ret;
}
export function __wbindgen_cast_0000000000000003(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("GPUUncapturedErrorEvent")], shim_idx: 796, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue______true__2);
    return ret;
}
export function __wbindgen_cast_0000000000000004(arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000005(arg0) {
    // Cast intrinsic for `I64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000006(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(F32)) -> NamedExternref("Float32Array")`.
    const ret = getArrayF32FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000007(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(I16)) -> NamedExternref("Int16Array")`.
    const ret = getArrayI16FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000008(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(I32)) -> NamedExternref("Int32Array")`.
    const ret = getArrayI32FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000009(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(I8)) -> NamedExternref("Int8Array")`.
    const ret = getArrayI8FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_000000000000000a(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U16)) -> NamedExternref("Uint16Array")`.
    const ret = getArrayU16FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_000000000000000b(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U32)) -> NamedExternref("Uint32Array")`.
    const ret = getArrayU32FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_000000000000000c(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
    const ret = getArrayU8FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_000000000000000d(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_000000000000000e(arg0) {
    // Cast intrinsic for `U64 -> Externref`.
    const ret = BigInt.asUintN(64, arg0);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
function wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue______true_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue______true_(arg0, arg1, arg2);
}

function wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue______true__2(arg0, arg1, arg2) {
    wasm.wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue______true__2(arg0, arg1, arg2);
}

function wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_a15a00f74afbf033___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___wasm_bindgen_a15a00f74afbf033___JsValue__core_608f92abc48d28da___result__Result_____wasm_bindgen_a15a00f74afbf033___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___js_sys_15d5b7dc83e46e31___Function_fn_wasm_bindgen_a15a00f74afbf033___JsValue_____wasm_bindgen_a15a00f74afbf033___sys__Undefined___js_sys_15d5b7dc83e46e31___Function_fn_wasm_bindgen_a15a00f74afbf033___JsValue_____wasm_bindgen_a15a00f74afbf033___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_a15a00f74afbf033___convert__closures_____invoke___js_sys_15d5b7dc83e46e31___Function_fn_wasm_bindgen_a15a00f74afbf033___JsValue_____wasm_bindgen_a15a00f74afbf033___sys__Undefined___js_sys_15d5b7dc83e46e31___Function_fn_wasm_bindgen_a15a00f74afbf033___JsValue_____wasm_bindgen_a15a00f74afbf033___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_GpuAddressMode = ["clamp-to-edge", "repeat", "mirror-repeat"];


const __wbindgen_enum_GpuBlendFactor = ["zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturated", "constant", "one-minus-constant", "src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha"];


const __wbindgen_enum_GpuBlendOperation = ["add", "subtract", "reverse-subtract", "min", "max"];


const __wbindgen_enum_GpuBufferBindingType = ["uniform", "storage", "read-only-storage"];


const __wbindgen_enum_GpuCanvasAlphaMode = ["opaque", "premultiplied"];


const __wbindgen_enum_GpuCompareFunction = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];


const __wbindgen_enum_GpuCullMode = ["none", "front", "back"];


const __wbindgen_enum_GpuFilterMode = ["nearest", "linear"];


const __wbindgen_enum_GpuFrontFace = ["ccw", "cw"];


const __wbindgen_enum_GpuIndexFormat = ["uint16", "uint32"];


const __wbindgen_enum_GpuLoadOp = ["load", "clear"];


const __wbindgen_enum_GpuMipmapFilterMode = ["nearest", "linear"];


const __wbindgen_enum_GpuPowerPreference = ["low-power", "high-performance"];


const __wbindgen_enum_GpuPrimitiveTopology = ["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip"];


const __wbindgen_enum_GpuSamplerBindingType = ["filtering", "non-filtering", "comparison"];


const __wbindgen_enum_GpuStencilOperation = ["keep", "zero", "replace", "invert", "increment-clamp", "decrement-clamp", "increment-wrap", "decrement-wrap"];


const __wbindgen_enum_GpuStorageTextureAccess = ["write-only", "read-only", "read-write"];


const __wbindgen_enum_GpuStoreOp = ["store", "discard"];


const __wbindgen_enum_GpuTextureAspect = ["all", "stencil-only", "depth-only"];


const __wbindgen_enum_GpuTextureDimension = ["1d", "2d", "3d"];


const __wbindgen_enum_GpuTextureFormat = ["r8unorm", "r8snorm", "r8uint", "r8sint", "r16uint", "r16sint", "r16float", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint", "r32uint", "r32sint", "r32float", "rg16uint", "rg16sint", "rg16float", "rgba8unorm", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint", "bgra8unorm", "bgra8unorm-srgb", "rgb9e5ufloat", "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat", "rg32uint", "rg32sint", "rg32float", "rgba16uint", "rgba16sint", "rgba16float", "rgba32uint", "rgba32sint", "rgba32float", "stencil8", "depth16unorm", "depth24plus", "depth24plus-stencil8", "depth32float", "depth32float-stencil8", "bc1-rgba-unorm", "bc1-rgba-unorm-srgb", "bc2-rgba-unorm", "bc2-rgba-unorm-srgb", "bc3-rgba-unorm", "bc3-rgba-unorm-srgb", "bc4-r-unorm", "bc4-r-snorm", "bc5-rg-unorm", "bc5-rg-snorm", "bc6h-rgb-ufloat", "bc6h-rgb-float", "bc7-rgba-unorm", "bc7-rgba-unorm-srgb", "etc2-rgb8unorm", "etc2-rgb8unorm-srgb", "etc2-rgb8a1unorm", "etc2-rgb8a1unorm-srgb", "etc2-rgba8unorm", "etc2-rgba8unorm-srgb", "eac-r11unorm", "eac-r11snorm", "eac-rg11unorm", "eac-rg11snorm", "astc-4x4-unorm", "astc-4x4-unorm-srgb", "astc-5x4-unorm", "astc-5x4-unorm-srgb", "astc-5x5-unorm", "astc-5x5-unorm-srgb", "astc-6x5-unorm", "astc-6x5-unorm-srgb", "astc-6x6-unorm", "astc-6x6-unorm-srgb", "astc-8x5-unorm", "astc-8x5-unorm-srgb", "astc-8x6-unorm", "astc-8x6-unorm-srgb", "astc-8x8-unorm", "astc-8x8-unorm-srgb", "astc-10x5-unorm", "astc-10x5-unorm-srgb", "astc-10x6-unorm", "astc-10x6-unorm-srgb", "astc-10x8-unorm", "astc-10x8-unorm-srgb", "astc-10x10-unorm", "astc-10x10-unorm-srgb", "astc-12x10-unorm", "astc-12x10-unorm-srgb", "astc-12x12-unorm", "astc-12x12-unorm-srgb"];


const __wbindgen_enum_GpuTextureSampleType = ["float", "unfilterable-float", "depth", "sint", "uint"];


const __wbindgen_enum_GpuTextureViewDimension = ["1d", "2d", "2d-array", "cube", "cube-array", "3d"];


const __wbindgen_enum_GpuVertexFormat = ["uint8", "uint8x2", "uint8x4", "sint8", "sint8x2", "sint8x4", "unorm8", "unorm8x2", "unorm8x4", "snorm8", "snorm8x2", "snorm8x4", "uint16", "uint16x2", "uint16x4", "sint16", "sint16x2", "sint16x4", "unorm16", "unorm16x2", "unorm16x4", "snorm16", "snorm16x2", "snorm16x4", "float16", "float16x2", "float16x4", "float32", "float32x2", "float32x3", "float32x4", "uint32", "uint32x2", "uint32x3", "uint32x4", "sint32", "sint32x2", "sint32x3", "sint32x4", "unorm10-10-10-2", "unorm8x4-bgra"];


const __wbindgen_enum_GpuVertexStepMode = ["vertex", "instance"];

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedInt16ArrayMemory0 = null;
function getInt16ArrayMemory0() {
    if (cachedInt16ArrayMemory0 === null || cachedInt16ArrayMemory0.byteLength === 0) {
        cachedInt16ArrayMemory0 = new Int16Array(wasm.memory.buffer);
    }
    return cachedInt16ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

let cachedInt8ArrayMemory0 = null;
function getInt8ArrayMemory0() {
    if (cachedInt8ArrayMemory0 === null || cachedInt8ArrayMemory0.byteLength === 0) {
        cachedInt8ArrayMemory0 = new Int8Array(wasm.memory.buffer);
    }
    return cachedInt8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
