# Sound Design System

This document covers how Canopy's notification sounds are generated, the design philosophy behind them, the synthesis architecture, and how to add or modify sounds in the future.

## Overview

Canopy's notification sounds are procedurally generated from pure math by `scripts/generate-sounds.mjs`. No external audio files, sample libraries, or Web Audio API are used. The entire synthesis engine is a Node.js script that writes raw PCM samples into WAV buffers.

The sounds serve as **earcons** — short semantic audio cues that let users identify agent state changes without looking at the screen. They are designed for hundreds of repetitions per day across multi-hour coding sessions.

### Running the Generator

```bash
node scripts/generate-sounds.mjs
```

Output: WAV files written to `electron/resources/sounds/`.

Builds are **deterministic** — a seeded PRNG (mulberry32, seed `0xCA0917`) replaces all `Math.random()` calls. Running the script twice produces byte-identical WAVs. Change the `SEED` constant to generate a different "take."

## Brand Identity: "Digital Ecology"

Canopy's metaphor is a forest canopy — a living ecosystem where AI agents work like organisms. This is expressed literally in the DSP architecture: a digital FM shimmer is fed **into** a physically modeled wooden resonator, so the technology literally passes through the wood. The tail of every sound is purely organic — physically modeled wood resonance fading naturally. This is "digital ecology" expressed as signal flow.

### Design Principles

1. **Earthy core** — Modal wood resonators are the primary voice
2. **Serial excitation** — FM shimmer passes THROUGH the wood, not beside it
3. **Dry UI** — Near-zero reverb (1-2% wet); sounds come from the app chrome, not a room
4. **Micro-feedback** — Short (200-500ms), sparse (1-2 notes max); earcons, not jingles
5. **Material-per-meaning** — Wood resonance/hardness varies by semantic role
6. **Brand anchor** — A4 to E5 (perfect fifth, 3:2 ratio) woven through all sounds
7. **Organic variation** — 4 pre-baked variants per sound, no-repeat round-robin at playback

### Influences

- **Zelda BOTW/TOTK** — "micro-feedback" philosophy: common events get a single pluck, not a melody. Dry UI audio separated from world audio. Kalimba/marimba as primary instruments.
- **Apple macOS** — Physical metaphors (glass, wood, droplet). Premium feel from acoustic quality and rapid decay, not from complexity.
- **Mobile game audio** — Round-robin variant cycling, strike zone micro-variance, anti-repeat selection. Research-validated sweet spots for variation parameters.

## Pitch Language

All pitches use **Just Intonation** (exact frequency ratios, no equal-temperament beating). Equal temperament produces micro-beating when played through pure digital waveforms. JI eliminates this.

| Note | JI Ratio | Frequency | Role                             |
| ---- | -------- | --------- | -------------------------------- |
| A4   | 1/1      | 440.00 Hz | Root — grounding, resolution     |
| B4   | 9/8      | 495.00 Hz | Suspension — waiting, unresolved |
| C#5  | 5/4      | 550.00 Hz | Darkness — used only in error    |
| D#5  | 45/32    | 618.75 Hz | Lydian #4 — wonder, discovery    |
| E5   | 3/2      | 660.00 Hz | Stability — completion, power    |
| F#5  | 5/3      | 733.33 Hz | Elevation — alertness            |

The **brand anchor** is A4 to E5 (perfect fifth). It appears in every sound.

The **pentatonic scale** contains zero minor seconds or tritones, making dissonance mathematically impossible.

The **Lydian raised fourth** (D#5) is borrowed from Zelda's "item get" language. Used only in the chime sound for a sense of wonder.

### Semantic Interval Mapping

| Pattern                               | Emotion                     | Used in  |
| ------------------------------------- | --------------------------- | -------- |
| Ascending (root to fifth)             | Positive, bright, arriving  | chime    |
| Descending (fifth to root)            | Resolved, settled, complete | complete |
| Ascending to unresolved (root to 9/8) | Tension, waiting, question  | waiting  |
| Single note at 5/4 with dark timbre   | Concern, fault, different   | error    |
| Single note at 3/2                    | Quick acknowledgment        | ping     |

## Synthesis Architecture

### Signal Flow

```
[FM shimmer burst] ---+
                      +--> [Modal wood resonators] --> [waveshape] --> output
[Mallet exciter] -----+             |
                            [detuned double added at output for width]
```

The FM component is not mixed alongside the wood — it is fed INTO the modal resonators as part of the excitation signal. The wood model physically shapes the digital shimmer. They fuse into one material.

### Layer 1: Modal Wood Resonators (Primary Voice)

A bank of 4 resonant bandpass biquad filters tuned to the inharmonic mode ratios of a vibrating wooden bar, derived from Euler-Bernoulli beam theory:

| Mode | Ratio  | Note                                                    |
| ---- | ------ | ------------------------------------------------------- |
| 1    | 1.000x | Fundamental                                             |
| 2    | 2.756x | Not an octave — this is what makes wood sound like wood |
| 3    | 5.404x |                                                         |
| 4    | 8.933x |                                                         |

Each mode has independent Q factor and amplitude. Higher modes have lower Q (they decay faster), reproducing how wood absorbs high-frequency energy — bright attack, warm tail.

The `resonance` parameter scales all Q factors: 0.7 = dead branch, 1.1 = resonant marimba bar.

**Split-fundamental beating:** The fundamental is actually two modes — one at 1.000x and a shadow at 1.004x (~7 cents sharp). They phase against each other, creating a slow ~1.8Hz amplitude pulse in the decay tail. Simulates imperfect wood density.

**Strike deformation:** A brief extra resonator 15Hz above the fundamental, decaying over 18ms. Simulates the momentary pitch spike when wood deforms under impact before settling.

### Layer 2: FM Excitation (Digital Shimmer)

A sine carrier frequency-modulated by a sine oscillator. The modulation index decays rapidly (within 50-100ms), so FM adds brightness only on the attack.

| Parameter     | Default          | Purpose                                                                          |
| ------------- | ---------------- | -------------------------------------------------------------------------------- |
| `fmRatio`     | 1.4142 (sqrt(2)) | Irrational ratio = woody inharmonics. Error uses sqrt(3) for metallic character. |
| `fmIndex`     | 1.5              | Modulation depth. Higher = more harmonics in the FM spectrum.                    |
| `fmDecayRate` | 16               | How fast FM dies. Higher = shorter shimmer.                                      |
| `fmAmt`       | 0.5              | Contribution to the composite excitation signal.                                 |

### Layer 3: Composite Mallet Exciter

Two components simulating a physical mallet:

1. **Brown noise** filtered through a bandpass SVF — surface contact texture. Brown noise (-6dB/octave) is darker than pink noise, sounding like organic friction and wood grain.
2. **Low-frequency sine sweep** (150 to 50Hz over 5-6ms) — mallet mass. Gives physical weight to the attack.

**Strike zone micro-variance:** Each time the exciter generates, the noise band center and thump start frequency are jittered by +/-5%. A real mallet never hits the exact same spot twice.

### Layer 4: Detuned Double

A second oscillator at +3 cents from the fundamental, added at the output (not through the wood). Provides organic width. Mixed at 8-12%.

### Layer 5: Attack Presence Fingerprint

A 6-14ms bandpass-filtered noise burst in the 1.8-3.2kHz presence range. Applied only on the attack, with different center frequency and Q per sound. This aids fast identification on laptop speakers — the 4kHz static lowpass would otherwise suppress this discrimination band.

| Sound    | Center Hz            | Q       | Amount    |
| -------- | -------------------- | ------- | --------- |
| chime    | 2600-2800            | 1.8-2.0 | 0.10-0.12 |
| complete | 1800-2000            | 1.0-1.2 | 0.06-0.08 |
| waiting  | 3000 (2nd note only) | 2.0     | 0.18      |
| error    | 2200                 | 1.0     | 0.16      |
| ping     | 2800                 | 2.5     | 0.14      |

## Post-Processing Chain

Applied in order to the raw synthesis output:

1. **Sympathetic chassis resonance** — A quiet modal resonator tuned to A4 (the brand root). Every sound excites it slightly, tying the family together acoustically. Mix varies per sound: complete = 3.5% (most grounding), error = 1% (most isolated).

2. **Dynamic material absorption** — A one-pole lowpass that sweeps from 6kHz to 800Hz exponentially over the note. Bright attack, dark tail — like wood absorbing vibrations.

3. **DC blocker** — High-pass at ~14Hz removes DC offset from the asymmetric waveshaper.

4. **Freeverb** — 4 parallel lowpass-feedback comb filters + 2 series allpass filters. 1-2% wet. Prime-number delay lengths (487, 577, 673, 751 samples) prevent metallic ringing.

5. **Static lowpass** — One-pole at 4kHz. Rolls off the tinnitus trigger zone (4-8kHz).

6. **Asymmetric waveshaper** — `tanh(x * 1.8 + 0.15) - tanh(0.15)`. The DC bias introduces even harmonics (2nd, 4th, 6th) for warm "tube/tape" character, unlike standard symmetric tanh which produces hollow odd harmonics.

7. **Peak normalization** with perceptual loudness hierarchy.

8. **Quadratic fade-out** — Last 20ms fades with `(1-t)^2`. Last sample guaranteed zero.

9. **TPDF dither** — Triangular dither at 16-bit export for smoother quiet tail quantization.

## The Five Sounds

### chime.wav — General Notification

- **Notes:** A4 (440Hz) then D#5 (619Hz) — ascending Lydian raised fourth
- **Duration:** ~411ms
- **Character:** Light bamboo. "Leaf" body. Moderate FM shimmer.
- **Emotion:** Bright, magical double-tap. "Something happened."
- **Target peak:** 0.70 (reference level)
- **Chassis mix:** 2.0%

### complete.wav — Agent Finished

- **Notes:** E5 (660Hz) then A4 (440Hz) — descending perfect fifth to root
- **Duration:** ~511ms
- **Character:** Warm marimba. "Trunk/root" body. Minimal FM, heavy mallet.
- **Emotion:** Settled resolution. "Task done, exhale."
- **Target peak:** 0.62 (softest — resolution should feel like an exhale)
- **Chassis mix:** 3.5% (most grounding)

### waiting.wav — Agent Needs Input

- **Notes:** A4 (440Hz) then B4 (495Hz) — ascending major second (unresolved)
- **Duration:** ~451ms
- **Character:** Harder wood. "Branch under tension" body. Velocity contrast (soft first tap, loud second).
- **Emotion:** Expectant question mark. "Your turn."
- **Rhythmic design:** 45ms hesitation gap between notes. Soft A4 grace note (amplitude 0.4) then insistent B4 knock (amplitude 0.6).
- **Target peak:** 0.75 (forward — needs to cut through focus)
- **Chassis mix:** 1.5%

### error.wav — Agent Failed (STATIC, no variants)

- **Notes:** C#5 (550Hz) — single note
- **Duration:** ~260ms
- **Character:** Dense dead wood. "Knot/stressed branch" body. FM ratio sqrt(3) for metallic character. Heavier mallet, darker noise band, pitch droops downward.
- **Emotion:** Concern without panic. "Something went wrong."
- **Target peak:** 0.75 (cuts through, but brief)
- **Chassis mix:** 1.0% (most isolated from family warmth)
- **No variants:** Critical sounds need Pavlovian consistency. Variation on error sounds is a known UX anti-pattern — users interpret pitch shifts as hardware glitches.

### ping.wav — Brief Acknowledgment

- **Notes:** E5 (660Hz) — single note (the brand "stability" note)
- **Duration:** ~220ms
- **Character:** Resonant wood. "Tine" body. Mostly mallet-driven, barely any FM. Clean kalimba pluck.
- **Emotion:** Quick, clean, over. "Heads up."
- **Target peak:** 0.68 (sharp but not dominant)
- **Chassis mix:** 2.0%

## Sound Variation System

### Why Variants Exist

Psychoacoustic research shows that even at low repetition rates (minutes apart), subtle sound variation creates a subconscious "physical object" classification in the brain. Identical repetition triggers a "synthetic/machine" classification. This is the "nice car turn signal" effect — you don't consciously notice variation, but the product feels more alive.

At Canopy's notification rate (every 2-12 minutes), sensory habituation is NOT the reason for variation — the auditory cortex fully recovers in 2-10 seconds. The value is purely in **perceived quality and craftsmanship**.

### Variation Philosophy

The metaphor is: **same instrument, different strike.** Like hitting a marimba bar in a slightly different spot with slightly different hand tension. The "identity core" (notes, intervals, duration, timing, loudness hierarchy) is invariant. Only micro-features change.

Research-validated sweet spots:

| Parameter                 | Variation Range | Rationale                                       |
| ------------------------- | --------------- | ----------------------------------------------- |
| Pitch                     | +/-12-15 cents  | Below conscious detection, above SSA threshold  |
| Upper partial amplitudes  | +/-15-25%       | Changes spectral tilt without breaking identity |
| Upper partial frequencies | +/-8-15 cents   | Simulates different strike positions on the bar |
| FM index                  | +/-15%          | Varies shimmer intensity                        |
| Mallet amount             | +/-10%          | Varies strike weight                            |
| Thump amount              | +/-15%          | Varies low-frequency impact                     |
| Noise band                | +/-10%          | Varies strike texture                           |
| Attack presence           | +/-15-20%       | Varies brightness of the transient click        |
| Resonance                 | +/-4%           | Varies ring time                                |

**What must NOT vary between variants:**

- Fundamental frequency (notes stay the same)
- Interval direction (ascending/descending)
- Duration and rhythmic timing
- Loudness hierarchy (target peak)
- Number of notes

### Variant Architecture

4 variants per sound (v0 = canonical, v1-v3 = variations). The `VARIANTS` array in the generator defines per-variant knob multipliers. `applyVariant()` applies these to the base note opts.

Each variant gets a unique PRNG seed: `SEED + variantIndex * 0x1000 + soundName.charCodeAt(0)`. This means the brown noise patterns, strike zone jitter, and timing jitter are all different per variant, on top of the explicit knob changes.

### Which Sounds Get Variants

| Sound    | Variants   | Reason                                                |
| -------- | ---------- | ----------------------------------------------------- |
| chime    | 4 (v0-v3)  | Common notification — benefits from organic feel      |
| complete | 4 (v0-v3)  | Frequent completion sound — organic variation         |
| waiting  | 4 (v0-v3)  | Most common sound — agents finish and wait frequently |
| ping     | 4 (v0-v3)  | Brief acknowledgment — organic feel                   |
| error    | 1 (static) | Critical sound — Pavlovian consistency required       |

### Playback: No-Repeat Round-Robin

`AgentNotificationService.resolveVariant()` discovers variant files by listing the sounds directory for siblings matching `{base}.v{N}.wav`. It randomly selects a variant, ensuring the same variant never plays twice consecutively.

For custom user sound files (no siblings in the sounds dir), the system passes through the original file unchanged.

### File Naming Convention

```
chime.wav       # v0 (canonical)
chime.v1.wav    # variant 1
chime.v2.wav    # variant 2
chime.v3.wav    # variant 3
```

The base file (without suffix) is always variant 0. Settings UI shows "Chime", "Complete", etc. — the variant suffix is internal.

## DSP Primitives Reference

The generator includes these reusable DSP building blocks:

| Class/Function                | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `PhaseOsc`                    | Phase-accumulating sine oscillator (click-free under frequency changes) |
| `Envelope`                    | ADSR envelope with exponential curves                                   |
| `expDecay(t, duration, rate)` | Simple exponential decay                                                |
| `SVFilter`                    | State-variable bandpass filter                                          |
| `DCBlocker`                   | Removes DC offset (~14Hz high-pass)                                     |
| `OnePole`                     | One-pole lowpass filter                                                 |
| `LowpassCombFilter`           | Comb filter with HF absorption in feedback loop                         |
| `AllpassFilter`               | Allpass filter for reverb diffusion                                     |
| `Freeverb`                    | 4 parallel LBCF + 2 series APF reverb                                   |
| `ModalResonator`              | Biquad bandpass resonator (one mode of the wood)                        |
| `WoodModal`                   | Bank of modal resonators + split-fundamental + strike deformation       |
| `PinkNoise`                   | Paul Kellet approximation                                               |
| `BrownNoise`                  | Integrated white noise (-6dB/octave)                                    |
| `waveshape(x, drive, bias)`   | Asymmetric tanh soft-clip                                               |
| `generateExcitation(n, opts)` | Composite mallet: brown noise + LF thump                                |
| `canopyNote(freq, dur, opts)` | Full Canopy note synthesizer                                            |
| `sequence(notes, opts)`       | Multi-note sequencer with humanized timing                              |
| `postProcess(samples, opts)`  | Full post-processing chain                                              |
| `writeWav(samples, path)`     | 16-bit mono PCM WAV writer with TPDF dither                             |

## Adding a New Sound

### Step 1: Choose the Musical Identity

Pick notes from the JI palette. Define the semantic intent:

- What state change does this sound represent?
- Should it feel resolved or unresolved?
- Is it positive, negative, or neutral?
- How common will it be? (Common = variants, rare = maybe static)
- Where does it sit in the loudness hierarchy?

### Step 2: Define the Base Parameters

Create a generator function following the pattern of `genChime`, `genComplete`, etc. Key parameters to set:

- `freq` — from the JI palette
- `resonance` — material character (0.7 dead to 1.1 resonant)
- `fmAmt` / `fmIndex` / `fmDecayRate` — how much digital shimmer
- `malletAmt` / `thumpAmt` / `noiseBandHz` — strike character
- `attackPresenceHz` / `attackPresenceAmt` — laptop speaker discrimination
- `targetPeak` — where in the loudness hierarchy
- `chassisMix` — how tied to the brand root

### Step 3: Wire Up Variants

If the sound will be common enough to benefit from variation:

1. Write a `genYourSound(variantIdx)` function that wraps note opts with `applyVariant()`
2. Add it to the `variantGenerators` object in the write section
3. The existing `VARIANTS` array and `applyVariant()` function handle the rest

If the sound should be static (critical/semantic):

1. Generate it as a `const` like `error`
2. Add it to `staticSounds`

### Step 4: Update the Notification Service

1. Add the new sound filename(s) to `electron/ipc/handlers/notifications.ts` (the allowlist)
2. Add it to the sound picker arrays in `NotificationSettingsTab.tsx` and `ProjectNotificationsTab.tsx`
3. If it maps to a new event type, update `AgentNotificationService.ts` to play it at the right time

### Step 5: Regenerate and Verify

```bash
node scripts/generate-sounds.mjs
```

Verify: all files play cleanly, variants are detectably different, typecheck passes, tests pass.

## Accessibility

- **Mono output** — for users with single-sided deafness
- **Fundamentals at 440-660Hz** — works well with hearing aids (which amplify 1-4kHz)
- **4kHz lowpass** — avoids tinnitus trigger zone (4-8kHz)
- **Soft attacks (>10ms)** — prevents hyperacusis shock
- **All sounds have visual toast equivalents** — WCAG 2.2 SC 1.3.3
- **All sounds under 3 seconds** — WCAG 2.2 SC 1.4.2

## Key Files

| File                                                  | Purpose                                               |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `scripts/generate-sounds.mjs`                         | Sound generator script (the synthesis engine)         |
| `electron/resources/sounds/*.wav`                     | Generated WAV files                                   |
| `electron/utils/soundPlayer.ts`                       | Cross-platform playback (afplay/paplay/PowerShell)    |
| `electron/services/AgentNotificationService.ts`       | When and how sounds are triggered, variant resolution |
| `electron/ipc/handlers/notifications.ts`              | Sound file allowlist, preview handler                 |
| `src/components/Settings/NotificationSettingsTab.tsx` | Global sound picker UI                                |
| `src/components/Project/ProjectNotificationsTab.tsx`  | Per-project sound picker UI                           |
| `electron/store.ts`                                   | Sound preference persistence                          |

## Future Considerations

- **Runtime micro-randomization:** `afplay` on macOS supports `--rate` which shifts pitch/speed. Adding `--rate ${0.96 + Math.random() * 0.08}` to `soundPlayer.ts` would give true per-playback variation on macOS. Linux/Windows would need Web Audio API migration.
- **Web Audio API migration:** Would enable real-time synthesis, infinite variation, and cross-platform pitch shifting. Requires a hidden BrowserWindow as an audio worker and IPC routing. High migration cost but the cleanest long-term architecture.
- **Additional event types:** The synthesis engine can produce new sounds by combining existing DSP primitives with new notes from the JI palette. Follow the pattern in "Adding a New Sound" above.
