"""Checks the driver's progress arithmetic with fake demucs callbacks. Needs neither torch nor demucs.

Run by stems-driver-progress.test.js as `python3 -I stems_driver_progress_check.py <driver path>`;
prints "ok" and exits 0 when every check holds, else raises.
"""
import importlib.util
import math
import sys

spec = importlib.util.spec_from_file_location("stems_demucs_driver", sys.argv[1])
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

SEGMENT = 343980  # htdemucs: 7.8 s at 44100 Hz
STRIDE = 257985  # overlap 0.25
TOTAL = 20 * 44100


def run(calls, total=TOTAL, segment=SEGMENT):
    last = 0.0
    seen = []
    for info in calls:
        value = driver.progress_from_info(info, total, segment, last)
        if value is not None:
            last = value
            seen.append(value)
    return seen


# A 20 s clip: 4 chunks, 8 callbacks (start and end of each), as demucs 4.1.0 sends them.
calls = []
for offset in (0, STRIDE, 2 * STRIDE, 3 * STRIDE):
    for state in ("start", "end"):
        calls.append({"model_idx_in_bag": 0, "shift_idx": 0, "segment_offset": offset, "models": 1, "state": state})
seen = run(calls)
assert len(seen) == 4, seen
expected = [min(1.0, (offset + SEGMENT) / TOTAL) for offset in (0, STRIDE, 2 * STRIDE, 3 * STRIDE)]
assert all(math.isclose(a, b) for a, b in zip(seen, expected)), (seen, expected)
assert seen == sorted(seen) and seen[-1] == 1.0 and 0 < seen[0] < 1

# 'start' never reports; progress never decreases (a second shift restarts the offsets)
assert run([{"state": "start", "segment_offset": 0}]) == []
again = run(calls + calls)
assert again == seen, again

# a bag of two models: the first model's chunks fill the first half
bag = [
    {"model_idx_in_bag": 0, "segment_offset": 0, "models": 2, "state": "end"},
    {"model_idx_in_bag": 1, "segment_offset": 0, "models": 2, "state": "end"},
]
half, full = run(bag)
assert math.isclose(half, (SEGMENT / TOTAL) / 2) and math.isclose(full, (1 + SEGMENT / TOTAL) / 2)

# a clip shorter than one segment is done after its only chunk
assert run([{"state": "end", "segment_offset": 0}], total=1000) == [1.0]

# garbage never raises and never reports
for bad in (
    None, 5, "end", [], {}, {"state": "end"}, {"state": "end", "segment_offset": None},
    {"state": "end", "segment_offset": "x"}, {"state": "end", "segment_offset": float("nan")},
    {"state": "end", "segment_offset": float("inf")}, {"state": "end", "segment_offset": -5},
    {"state": "END", "segment_offset": 0}, {"state": ["end"], "segment_offset": 0},
):
    assert run([bad]) == [], bad
assert driver.progress_from_info({"state": "end", "segment_offset": 0}, 0, SEGMENT, 0.0) is None
assert driver.progress_from_info({"state": "end", "segment_offset": 0}, None, SEGMENT, 0.0) is None
# odd 'models' / 'model_idx_in_bag' values fall back to a single model
assert run([{"state": "end", "segment_offset": 0, "models": "2", "model_idx_in_bag": 7}]) == [SEGMENT / TOTAL]


class Single:
    segment = 7.8
    samplerate = 44100


class Fraction:  # demucs keeps `segment` as a Fraction in some models
    segment = __import__("fractions").Fraction(39, 5)
    samplerate = 44100


class Bag:
    models = [Single(), Single()]


assert driver.segment_samples_of(Single()) == 343980
assert driver.segment_samples_of(Fraction()) == 343980
assert driver.segment_samples_of(Bag()) == 343980
assert driver.segment_samples_of(object()) == 0
assert driver.segment_samples_of(None) == 0

# the callback prints one JSON line per new value and nothing else
import io, json
buffer = io.StringIO()
real = sys.stdout
sys.stdout = buffer
try:
    callback = driver.make_callback(TOTAL, SEGMENT)
    for info in calls + [{"state": "end"}, None]:
        callback(info)
finally:
    sys.stdout = real
lines = [json.loads(line) for line in buffer.getvalue().splitlines()]
assert [line["progress"] for line in lines] == seen, lines
assert all(list(line) == ["progress"] for line in lines)

print("ok")
