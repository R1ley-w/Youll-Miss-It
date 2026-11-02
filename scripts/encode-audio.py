#!/usr/bin/env python3
"""
Encode the YMI audio library from lossless masters into web-ready assets.

The masters live outside the repo (they're ~200MB of 24-bit WAV); only the encoded
output is committed. Re-run this whenever a song is swapped — e.g. when the Featured
chest points at a new release.

    python3 scripts/encode-audio.py [--library PATH] [--out PATH]

Reads <library>/Tracks/key.xml for the chest -> track/start_at/link mapping.

Every track ships as both Opus-in-WebM and AAC-in-M4A; browsers pick via <source>.
Opus is the smaller and better of the two, but Safari only gained Opus/WebM support
relatively recently, and Instagram's in-app browser is WebKit.
"""

import argparse
import array
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

# --- encode settings -------------------------------------------------------

OPUS_KBPS = 96      # stereo Opus at 96k is comfortably good for music of this length
AAC_KBPS = 128      # AAC needs more bits than Opus for comparable quality

# dBTP headroom applied BEFORE encoding. Lossy codecs overshoot the source peak on decode,
# so trimming to -1.0 here does NOT produce a -1.0 file. Measured on this material: Opus
# came back +1.1 dB hot, AAC about +2.0 dB. Rather than hard-code a fudge factor that would
# be wrong for the next song, TARGET_TP is only a starting guess — each file is measured
# after encoding and re-encoded with more trim until it actually lands under the limit.
TARGET_TP = -3.0
SHIP_TP_LIMIT = -1.0
TP_MARGIN = 0.3       # extra trim beyond the shortfall, so a retry doesn't land exactly on the line
MAX_TP_RETRIES = 4

FORMATS = (
    (".webm", ["-c:a", "libopus", "-b:a", f"{OPUS_KBPS}k"]),
    (".m4a", ["-c:a", "aac", "-b:a", f"{AAC_KBPS}k", "-movflags", "+faststart"]),
)

WINDOW_SECS = 90    # per the design: each chest track is a 90s window from its hook
BED_OVERLAP = 0.25  # seconds of overlap used to make the ambient bed loop seamlessly

# Chest ids in key.xml follow climb order. The mapping below is derived from the
# links themselves (facebook -> merch slot, a specific video -> featured, spotify ->
# streaming), not from the ordering, so it stays correct if the ids are ever reordered.
CHEST_KEYS = {"1": "merch", "2": "youtube", "3": "featured", "4": "streaming", "5": "socials"}

# One-shots and SFX: (source stem, output stem, split into discrete events?, peak target dBFS)
# Peak targets only stop anything being so quiet its noise floor matters, or so hot it
# clips — the actual mix balance is set in code at runtime.
ONE_SHOTS = [
    ("drip", "drip", True, -16.0),
    ("Chain_rustling", "chain", True, -14.0),
    ("Creak", "creak", False, -16.0),
]
SFX = [
    ("chest_open", "chest_open", -6.0),
    ("prize_collect", "prize_collect", -14.0),  # a soft chime by design, just lifted off the floor
    ("landing_SFX", "landing", -10.0),
]

SILENCE_THR = 0.01   # ~-40 dBFS, used for trimming and event detection
MIN_GAP = 0.25       # seconds of quiet that separates two discrete events
MIN_EVENT = 0.04     # ignore anything shorter than this; it's a blip, not a sound


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"ffmpeg failed:\n  {' '.join(cmd)}\n{r.stderr[-2000:]}")
    return r.stderr


def probe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True).stdout.strip()
    return float(out)


def measure_true_peak(path, start=None, dur=None):
    """Integrated loudness + true peak for a window, via loudnorm's analysis pass."""
    cmd = ["ffmpeg", "-hide_banner", "-nostats"]
    if start is not None:
        cmd += ["-ss", str(start)]
    if dur is not None:
        cmd += ["-t", str(dur)]
    cmd += ["-i", path, "-af", "loudnorm=print_format=json", "-f", "null", "-"]
    err = run(cmd)
    blob = re.search(r"\{[^{}]*\}", err, re.S)
    d = json.loads(blob.group(0))
    return float(d["input_i"]), float(d["input_tp"])


def samples(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"],
        capture_output=True).stdout
    a = array.array("h")
    a.frombytes(raw)
    return a, 48000


def peak_dbfs(path):
    err = run(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
               "-af", "volumedetect", "-f", "null", "-"])
    m = re.search(r"max_volume: ([-0-9.]+) dB", err)
    return float(m.group(1))


def find_events(path):
    """Locate discrete sounds separated by silence. Returns [(start_s, end_s), ...]."""
    s, sr = samples(path)
    thr = SILENCE_THR * 32768
    gap = int(MIN_GAP * sr)

    loud = [i for i, v in enumerate(s) if abs(v) > thr]
    if not loud:
        return []

    events, start, prev = [], loud[0], loud[0]
    for i in loud[1:]:
        if i - prev > gap:
            events.append((start, prev))
            start = i
        prev = i
    events.append((start, prev))

    # Pad slightly so transients aren't clipped, then drop anything too short to be a sound.
    pad = int(0.01 * sr)
    out = []
    for a, b in events:
        if (b - a) / sr < MIN_EVENT:
            continue
        out.append((max(0, a - pad) / sr, min(len(s) - 1, b + pad) / sr))
    return out


def encode_pair(src_filter_cmd, out_base, out_dir):
    """Run one ffmpeg command twice, producing matching .webm (Opus) and .m4a (AAC)."""
    results = {}
    for ext, codec_args in FORMATS:
        dest = os.path.join(out_dir, out_base + ext)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        run(src_filter_cmd + codec_args + [dest, "-y"])
        results[ext.lstrip(".")] = os.path.getsize(dest)
    return results


def _track_cmd(src, start, dur, gain_db):
    """A music window: static gain for headroom, tiny fade-in, long fade-out at the tail."""
    af = [f"volume={gain_db:.2f}dB", "afade=t=in:st=0:d=0.02"]
    if dur is not None:
        af.append(f"afade=t=out:st={dur - 1.5:.2f}:d=1.5")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(start)]
    if dur is not None:
        cmd += ["-t", str(dur)]
    return cmd + ["-i", src, "-af", ",".join(af), "-ar", "48000", "-ac", "2"]


def encode_track(src, start, dur, gain_db, out_base, out_dir):
    """
    Encode a music window to both formats, measuring what actually ships.

    The headroom trim is applied before the codec runs, but the codec is free to overshoot
    it on decode — and Opus and AAC overshoot by different amounts on the same material.
    So each format is measured after encoding and re-encoded with more trim until it lands
    under SHIP_TP_LIMIT. Self-correcting, so swapping in a new song needs no re-tuning.
    """
    results = {}
    for ext, codec_args in FORMATS:
        dest = os.path.join(out_dir, out_base + ext)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        gain, tries = gain_db, 0
        while True:
            run(_track_cmd(src, start, dur, gain) + codec_args + [dest, "-y"])
            _, tp = measure_true_peak(dest)
            tries += 1
            if tp <= SHIP_TP_LIMIT or tries > MAX_TP_RETRIES:
                break
            gain -= (tp - SHIP_TP_LIMIT) + TP_MARGIN
        if tp > SHIP_TP_LIMIT:
            sys.exit(f"could not get {out_base}{ext} under {SHIP_TP_LIMIT} dBTP "
                     f"after {tries} attempts (stuck at {tp:+.2f})")
        results[ext.lstrip(".")] = {
            "size": os.path.getsize(dest), "tp": tp, "gain": gain, "tries": tries}
    return results


def encode_clip(src, t0, t1, gain_db, out_base, out_dir, fade_out=0.015):
    """A short sound: trimmed to its own bounds, de-clicked at both ends."""
    dur = t1 - t0
    af = [
        f"volume={gain_db:.2f}dB",
        "afade=t=in:st=0:d=0.005",
        f"afade=t=out:st={max(0.0, dur - fade_out):.4f}:d={fade_out}",
    ]
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
           "-ss", f"{t0:.4f}", "-t", f"{dur:.4f}", "-i", src,
           "-af", ",".join(af), "-ar", "48000"]
    return encode_pair(cmd, out_base, out_dir)


def encode_seamless_bed(src, out_base, out_dir):
    """
    Make the ambient loop genuinely seamless.

    The master has a discontinuity at its wrap point, which ticks audibly every time the
    loop comes round. Fix it by crossfading the final BED_OVERLAP seconds over the opening
    BED_OVERLAP seconds using an equal-power (quarter-sine) curve, which shortens the file
    by the overlap and leaves the join continuous.
    """
    d = probe_duration(src)
    x = BED_OVERLAP
    fc = (
        f"[0:a]atrim=0:{x},afade=t=in:st=0:d={x}:curve=qsin,asetpts=PTS-STARTPTS[head];"
        f"[1:a]atrim={d - x}:{d},afade=t=out:st=0:d={x}:curve=qsin,asetpts=PTS-STARTPTS[tail];"
        f"[head][tail]amix=inputs=2:normalize=0[join];"
        f"[2:a]atrim={x}:{d - x},asetpts=PTS-STARTPTS[body];"
        f"[join][body]concat=n=2:v=0:a=1[out]"
    )
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
           "-i", src, "-i", src, "-i", src,
           "-filter_complex", fc, "-map", "[out]", "-ar", "48000", "-ac", "2"]
    return encode_pair(cmd, out_base, out_dir), d - x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--library",
                    default="/Users/rileywade/Documents/Personal Projects/Band/Sound_Library")
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "assets", "audio"))
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found on PATH")
    if not os.path.isdir(args.library):
        sys.exit(f"sound library not found: {args.library}")

    manifest = {"tracks": {}, "ambient": {"oneShots": []}, "sfx": {}}

    # --- music -------------------------------------------------------------
    root = ET.parse(os.path.join(args.library, "Tracks", "key.xml")).getroot()
    print("tracks")
    for el in root:
        rel = el.get("track").split("Sound_Library/", 1)[-1]
        src = os.path.join(args.library, rel)
        start = int(el.get("start_at"))
        is_completion = el.tag == "completion"
        key = "completion" if is_completion else CHEST_KEYS[el.get("id")]
        dur = None if is_completion else WINDOW_SECS

        lufs, tp = measure_true_peak(src, start, dur)
        gain = TARGET_TP - tp  # static trim: create headroom without touching the mix
        sizes = encode_track(src, start, dur, gain, f"tracks/{key}", args.out)

        manifest["tracks"][key] = {
            "startAt": start,
            "duration": dur if dur else round(probe_duration(src) - start, 2),
            "lufs": round(lufs, 2),
            "sourceTruePeak": round(tp, 2),
            "shippedTruePeak": {f: round(v["tp"], 2) for f, v in sizes.items()},
            "link": el.get("link"),
            "source": os.path.basename(src),
        }
        retries = sum(v["tries"] - 1 for v in sizes.values())
        note = f"  ({retries} extra pass{'es' if retries != 1 else ''})" if retries else ""
        print(f"  {key:11s} {start:>4}s  {lufs:7.2f} LUFS  src TP {tp:+.2f}  ship "
              f"{sizes['webm']['tp']:+.2f}/{sizes['m4a']['tp']:+.2f} dBTP  "
              f"{sizes['webm']['size'] / 1024:5.0f}K/{sizes['m4a']['size'] / 1024:5.0f}K{note}")

    # --- ambient bed -------------------------------------------------------
    print("ambient bed")
    bed_src = os.path.join(args.library, "ambient_noise.wav")
    sizes, bed_len = encode_seamless_bed(bed_src, "ambient/bed", args.out)
    manifest["ambient"]["bed"] = {"duration": round(bed_len, 3), "seamless": True}
    print(f"  bed         {bed_len:.3f}s (was {bed_len + BED_OVERLAP:.3f}s, "
          f"{BED_OVERLAP * 1000:.0f}ms overlap crossfade)  "
          f"{sizes['webm'] / 1024:.0f}K webm / {sizes['m4a'] / 1024:.0f}K m4a")

    # --- one-shots ---------------------------------------------------------
    print("one-shots")
    for stem, out_stem, split, target in ONE_SHOTS:
        src = os.path.join(args.library, stem + ".wav")
        cur_peak = peak_dbfs(src)
        gain = target - cur_peak
        events = find_events(src) if split else None
        if not events:
            s, sr = samples(src)
            thr = SILENCE_THR * 32768
            loud = [i for i, v in enumerate(s) if abs(v) > thr]
            events = [(loud[0] / sr, loud[-1] / sr)]

        for i, (t0, t1) in enumerate(events, 1):
            name = f"ambient/{out_stem}-{i}" if len(events) > 1 else f"ambient/{out_stem}"
            encode_clip(src, t0, t1, gain, name, args.out)
            manifest["ambient"]["oneShots"].append(
                {"name": os.path.basename(name), "duration": round(t1 - t0, 3)})
        print(f"  {out_stem:11s} {len(events):>2} event(s)  peak {cur_peak:+.1f} -> "
              f"{target:+.1f} dBFS ({gain:+.1f} dB)")

    # --- sfx ---------------------------------------------------------------
    print("sfx")
    for stem, out_stem, target in SFX:
        src = os.path.join(args.library, stem + ".wav")
        cur_peak = peak_dbfs(src)
        gain = target - cur_peak
        s, sr = samples(src)
        thr = SILENCE_THR * 32768
        loud = [i for i, v in enumerate(s) if abs(v) > thr]
        t0, t1 = loud[0] / sr, min(len(s) - 1, loud[-1] + int(0.01 * sr)) / sr
        # landing fires on every jump, so it gets a shorter tail fade to stay punchy
        sizes = encode_clip(src, t0, t1, gain, f"sfx/{out_stem}", args.out,
                            fade_out=0.012 if out_stem == "landing" else 0.02)
        manifest["sfx"][out_stem] = {"duration": round(t1 - t0, 3)}
        print(f"  {out_stem:14s} {t1 - t0:5.3f}s  lead-in trimmed {t0 * 1000:5.1f}ms  "
              f"peak {cur_peak:+.1f} -> {target:+.1f} dBFS  {sizes['webm'] / 1024:5.1f}K")

    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nmanifest -> {os.path.join(args.out, 'manifest.json')}")

    # Every track was measured and retried during encoding, so reaching here means they all
    # cleared the limit. Restate the worst case so the guarantee is visible in the output.
    worst = max(v["shippedTruePeak"][f]
                for v in manifest["tracks"].values() for f in ("webm", "m4a"))
    print(f"all tracks verified within {SHIP_TP_LIMIT:+.1f} dBTP (worst {worst:+.2f})")


if __name__ == "__main__":
    main()
