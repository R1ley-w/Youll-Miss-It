# Audio design — You'll Miss It!

Settled across a grilling session (2026-11-02), then implemented in `src/systems/audio.ts`.
This is the authoritative record of the *why*; the commit history records the *how*.

## Intent

The songs **are** the content. This is a band's link hub, and proximity audio is the only
thing on the site that lets someone hear the music without clicking. Every close call was
resolved toward "always deliver the hook."

## Architecture

- **One Web Audio graph, outside Phaser**, in `src/systems/audio.ts` — music, ambient bed and
  SFX together. `main.ts` destroys and recreates the whole Phaser game when the viewport
  crosses the portrait/landscape threshold, so anything in Phaser's sound manager dies with
  it. One unlock, one master gain, one mute.
- Songs: media elements → `MediaElementAudioSourceNode` → per-track `GainNode` → master.
- Bed and SFX: decoded `AudioBuffer`s — sample-accurate looping for the bed, low-latency
  triggering for SFX.
- All gain via `setTargetAtTime`, **never** `gain.value = x` per frame.
- The scene is a dumb position feed: `setLayout(layout)`, `update(x, y)`, plus event calls.
- Max **two** song elements loaded at once (current + outgoing); release the rest.
- **Not** in Phaser's `preload()` — the scene already blocks on 48 assets and that loader
  gates the game appearing at all.

## Platform constraints (not optional)

### Never let WebKit play Opus through Web Audio

Safari/WebKit plays Opus-in-WebM through an `<audio>` element perfectly — and routes
**literally zero signal** into a `MediaElementAudioSourceNode` (measured peak RMS downstream:
`0.00000`). `createMediaElementSource()` does not throw. The failure mode is the worst
possible one: the song plays at full volume, completely ignoring proximity.

Safari answers `canPlayType('audio/webm; codecs=opus')` with `"probably"`, so a `<source>`
list with `.webm` first means Safari *chooses* the broken path.

**Do:** serve `.m4a` to WebKit (Safari, iOS, and the in-app browsers built on it — Instagram
is the main traffic source) and Opus/WebM to everyone else. Set `el.src` directly rather than
`<source>` children, and create media elements *after* the AudioContext exists.

### Await `ctx.resume()` before scheduling anything

`resume()` is async. Until it settles `ctx.currentTime` is frozen, so ramps scheduled against
it land in the past the moment the clock moves — gain jumps to its final value and the result
is silence. Chromium reports `running` immediately after a gesture; **WebKit reports
`suspended` and resumes a beat later**.

**Do:** `await ctx.resume()` *and* poll until `ctx.state === 'running'` before any ramp or
source start. Re-check before each playback start. Schedule with a small lead,
`ctx.currentTime + 0.05`.

## Proximity mechanic

- **R ≈ 210px**, as a field on `Layout` (`audioRadius`) beside `physics` — the two maps are
  shaped nothing alike.
- **Nearest chest wins**, with ~20px hysteresis to stop flapping at the midpoint.
- Gain curve ≈ `(1 − d/R)^1.5`. Linear sounds abrupt.
- Proximity tracking time constant ~**0.12s**; track-swap crossfade ~**0.8s** (deliberately
  short — two songs from the same album overlapping for longer is a real musical risk).
- Re-entering a chest's field **restarts that track at the hook**, every time.
- Spawn sits outside every chest's field in *both* layouts by design: you land in a dungeon
  hearing only drips, and the first song arrives as an event as you near the Merch chest.
- Swaps happen at the midpoint where both tracks sit near a third of volume — the most
  forgiving place to cross two different songs.

Measured geometry (for tuning): portrait closest chest pair 208px, spawn 213px from nearest;
landscape closest pair 182px, spawn 219px, and a 437px gap between Featured and Listen.

## Ambient bed

- **Always on**, ducked by the active song: `bedGain = bedBase × (1 − songGain)`.
- One seamless 31.75s stereo loop with **no distinct events**, plus the 9 one-shots
  (6 drips, 2 chain, 1 creak) re-scheduled at randomised **4–12s** intervals.
- Read the one-shot list from `manifest.json` rather than hard-coding names — the count is a
  property of the source recordings and will change if they're re-recorded.

## SFX

Chest open, prize/collect, and **landing** (no jump takeoff, no footsteps — at Greg's run
frame rate footsteps would be a machine gun).

## The reward beat

Lives on `runRewardSequence()` in `DungeonScene.ts`, which fires on **return** to the tab
rather than on departure — opening a chest calls `window.open()`, so anything spent at that
moment plays to a tab the visitor has already left.

`SEQUENCE_MS` goes **1000 → 1400ms**. The sequence:

> bed ducks to silence → chest open (creak) → song **seeks to the hook** and swells to full →
> prize SFX as the item lands

The hook seek is masked by the bed cut and creak firing on the same frame. Note `SEQUENCE_MS`
also governs the movement lock, and 1400ms is near the ceiling of what reads as punctuation
rather than a freeze — if it feels bad, shorten the swell, not the lock.

## Tab visibility

Suspend the context on hide; resume mid-song on return. Nothing ever plays over
Spotify/YouTube.

## Completion

A **sixth track** takes over at full volume with proximity suspended while the overlay is up,
and **keeps playing to its end** after "Back to Game" before proximity resumes. Bed silent
throughout. Lazy-load it when the **fourth** item is collected. Returning completionists do
not re-fire it — that moment already happened for them.

## Controls

- **Single master mute** covering music, bed and SFX. Persist as `ymi-audio-v1` alongside the
  existing `ymi-inventory-v1` / `ymi-pending-v1`.
- **Auto-starts on the first gesture** with a ~1.5s fade-in; a previous mute choice is
  respected.
- **Fixed top-right**, visible from page load (it must not appear *with* the audio).
- Styled to the current language: `#dc4e2b` accent, `#dfdbd2` border, Helvetica, 2–4px radius.

## Analytics

`song_heard_<chest>` once per session at 10s of audible playback, plus `audio_muted` — the one
number that says whether auto-start was the right call. Uses the existing `trackEvent` helper.

## Rotate

Keep the song playing and recompute against the new layout. Greg respawns at ground level,
which is outside every field, so the generic rules fade the song out and bring the bed up — no
special-casing.

## Levels

`bedBase`, SFX balance against music, and master default are deliberately **undecided** — they
are ear decisions, not argument decisions. Ship them as tunable constants.

## Chest → song → link mapping

Authoritative source is `public/assets/audio/manifest.json`. Riley chose the mapping; the ids
in the source `key.xml` follow climb order.

| key | hook (startAt) | link |
|---|---|---|
| merch | 31s | facebook.com/youllmissitband |
| youtube | 11s | youtube.com/@youllmissitband |
| featured | 135s | a specific YouTube video |
| streaming | 11s | Spotify artist page |
| socials | 0s | instagram.com/youllmissitband |
| completion | 0s | — (full track, 245s) |
