"""Ccut stems engine A: separates one song into drums, bass, other and vocals with Demucs (htdemucs).

Run by the managed virtual environment's python, offline (the checkpoint is already in TORCH_HOME):
    python -I stems_demucs_driver.py --rate R --channels 2 --frames N --input input.pcm --out DIR --checkpoint FILE

Input : raw signed 16-bit little-endian interleaved PCM, R Hz, `channels` channels.
Output: DIR/{drums,bass,other,vocals}.f32, mono, 22050 Hz, float32 little-endian.
stdout: one JSON object per line, {"progress": 0..1}, and finally {"done": true}. Nothing else.
--checkpoint is the pinned model file in TORCH_HOME; the run stops with a clear message if it is missing.
This file touches only --input, --out and the --checkpoint check, and has no network code.
"""
import argparse
import json
import math
import os
import sys

OUT_RATE = 22050
DEMUCS_RATE = 44100


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rate", type=int, required=True)
    parser.add_argument("--channels", type=int, required=True)
    parser.add_argument("--frames", type=int, required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--checkpoint", required=True)
    return parser.parse_args()


def load_wave(args):
    import numpy as np
    import torch

    raw = np.fromfile(args.input, dtype="<i2")
    if raw.size != args.frames * args.channels:
        raise SystemExit("input size does not match --frames")
    wav = torch.from_numpy(raw.reshape(-1, args.channels).astype("float32") / 32768.0)
    return wav.t().contiguous()  # (channels, frames)


def resample_if_needed(wav, rate):
    if rate == DEMUCS_RATE:
        return wav
    try:
        import torchaudio.functional as taf
    except ImportError:
        raise SystemExit("torchaudio is needed to resample %d Hz audio" % rate)
    return taf.resample(wav, rate, DEMUCS_RATE)


def segment_samples_of(model):
    """The model's segment length in samples (model.segment seconds x model.samplerate); 0 if unknown.

    A BagOfModels exposes its members as .models; the first one speaks for all of them.
    """
    try:
        target = model
        members = getattr(model, "models", None)
        if members:
            target = members[0]
        samples = int(float(target.segment) * float(target.samplerate))
        return samples if samples > 0 else 0
    except Exception:
        return 0


def progress_from_info(info, total_samples, segment_samples, last):
    """Progress 0..1 after one demucs callback, or None when nothing new should be reported.

    demucs 4.1 calls back with a dict: state ('start' | 'end'), segment_offset (the chunk's start,
    in samples at the model's rate), model_idx_in_bag, models (how many) and shift_idx. It has no
    audio length: `total_samples` is the length of the audio handed to apply_model. A chunk counts as
    done on state == 'end'. Never decreases (the shifts restart the offsets), never raises.
    """
    try:
        if info.get("state") != "end" or not total_samples or total_samples <= 0:
            return None
        offset = float(info.get("segment_offset"))
        if not math.isfinite(offset) or offset < 0:
            return None
        fraction = min(1.0, (offset + max(0, segment_samples)) / float(total_samples))
        count = info.get("models", 1)
        index = info.get("model_idx_in_bag", 0)
        count = count if isinstance(count, int) and not isinstance(count, bool) and count >= 1 else 1
        index = index if isinstance(index, int) and not isinstance(index, bool) and 0 <= index < count else 0
        value = min(1.0, (index + fraction) / count)
    except Exception:
        return None
    return value if value > last else None


def make_callback(total_samples, segment_samples):
    state = {"last": 0.0}

    def callback(info):
        value = progress_from_info(info, total_samples, segment_samples, state["last"])
        if value is not None:
            state["last"] = value
            emit({"progress": value})

    return callback


def to_mono_22050(stem):
    mono = stem.mean(0)  # average the channels
    pairs = mono.shape[0] // 2  # drop an odd last sample
    return mono[: pairs * 2].reshape(pairs, 2).mean(1)  # 44100 -> 22050 by averaging pairs


def main():
    args = parse_args()
    if not os.path.isfile(args.checkpoint):
        sys.stderr.write("the pinned model checkpoint is missing: %s\n" % args.checkpoint)
        raise SystemExit(3)
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    threads = os.environ.get("OMP_NUM_THREADS")
    if threads and threads.isdigit() and int(threads) > 0:
        torch.set_num_threads(int(threads))

    wav = resample_if_needed(load_wave(args), args.rate)
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)

    model = get_model("htdemucs")
    model.eval()
    total_samples = int(wav.shape[1])
    segment_samples = segment_samples_of(model)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    wav = (wav - mean) / (std + 1e-8)

    with torch.no_grad():
        out = apply_model(
            model, wav[None], device="cpu", split=True, overlap=0.25, shifts=1, progress=False, callback=make_callback(total_samples, segment_samples)
        )[0]
    out = out * (std + 1e-8) + mean  # (sources, channels, samples)

    for index, name in enumerate(model.sources):
        data = to_mono_22050(out[index]).contiguous().numpy().astype("<f4")
        data.tofile(os.path.join(args.out, name + ".f32"))
    emit({"done": True})


if __name__ == "__main__":
    main()
