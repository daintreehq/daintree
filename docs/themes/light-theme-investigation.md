# Why Daintree's light themes look washed-out

> Investigation output. The theme engine is an additive-glow model designed for dark, then mirrored to light by flipping `overlayTone` white→black. Ranked root causes below; 2 of 9 initial claims were refuted under verification and are kept here so they aren't chased.

## 1. The short answer

The theme engine (`shared/theme/themes.ts`) is an **additive-glow model designed for dark**, then mirrored for light by flipping one variable: `overlayTone = dark ? "#ffffff" : "#000000"` (themes.ts:92). On a dark canvas, layering white _adds_ luminance — hovers, borders, and elevation read as glow with large Weber contrast against the dark field. On a near-white canvas, layering black at near-identical (often _lower_) alpha barely darkens a surface where the eye's luminance discrimination is already compressed against the L=1.0 ceiling, so the same "step" is nearly invisible. The light themes aren't mis-colored — they run the correct machinery at a base lightness that leaves it 2-3x less perceptual room to work, compounded by light palettes that crowd all five surfaces into the top ~5-8% of the lightness scale.

## 2. Why dark themes look great (north star)

Six principles, all of which are _most effective at low base lightness_:

- **Wide surface stepping.** daintree's five surfaces (`#0e0e0d / #131312 / #19191a / #1d1d1e / #2b2b2c`) span **0.126 OKLab L**, and reserve the _largest_ step (+0.058) for the topmost `elevated` plane — the floating-tier cue. fiordland spans 0.160, highlands 0.171.
- **Additive white glow.** A 5% white hover over `#19191a` lifts +0.049 L and reads as emitted light; Weber contrast ~47%.
- **Bright, saturated accents that advance.** daintree `#36CE94` = L 0.760 / C 0.151, sitting **+0.546 L above** its canvas at 8.71:1 — the brightest, most saturated object on screen, which is exactly why the "one load-bearing accent" rule works.
- **Atmospheric shadows.** daintree's floating shadow `0 14px 40px rgba(0,0,0,0.25)` reads as real, foggy depth over a dark field.
- **Tinted material.** A light chromatic `overlayTint` (`#D4E8DD` mint) + 115% saturation injects coherent color temperature into chrome.
- **Borderless luminance depth.** Dark expresses containment through luminance steps alone; `panel-state-edge-width` is 0px on dark (themes.ts:249).

## 3. Root causes, ranked

### RC-1 — Surface ramps crushed against the white ceiling _(HIGH, verified)_

**Mechanism:** Depth is read as luminance difference between stacked planes. Light palettes pin their canvas near L 0.95-0.97 with almost no headroom above white, so the five surfaces converge into one undifferentiated sheet. This is the structural prerequisite for every other failure — every downstream depth cue composites onto a region of the curve where its output collapses.

**Evidence (OKLab L via the engine's own `hexToOklch`):**

- bondi `#EDEFF2 / #F0F1F4 / #F5F6F8 / #FAFBFC / #FFFFFF` = 0.951 / 0.958 / 0.973 / 0.988 / 1.000, **span 0.049**; grid→sidebar step is **0.007**, below the engine's own `RAMP_DL_JND = 0.020` (oklch.ts:22).
- serengeti span 0.063, hokkaido 0.067, table-mountain 0.071, bali 0.077, svalbard 0.078 — all roughly half of daintree's 0.126.

**Ramp-shape inversion (the strongest finding, universal):** All 7 dark themes reserve their _largest_ adjacent step for `panel→elevated` (daintree +0.058, fiordland +0.064, highlands +0.067). All 7 light themes make `panel→elevated` their _smallest_ step: bondi +0.012, serengeti/hokkaido/table-mountain +0.009, svalbard +0.012, bali +0.014. WCAG confirms collapse: serengeti panel `#FDFAF2` vs elevated `#FFFDF7` = **1.025:1**; bondi grid vs sidebar = 1.020:1. So floating elements get _no_ luminance lift at the top of the stack.

**Correction (verification):** The pre-investigation claim that atacama is the template proving "a true light elevated lift is possible" is **wrong**. atacama's span (0.101) is good, but it achieves it purely by dropping its _grid floor_ to L 0.879 — its `panel→elevated` step is still only **0.020** (the smallest in its own ramp, tied to the JND floor). atacama proves a wider span is possible in the engine; it does **not** prove a real elevated lift exists. Even atacama is affected by the shape inversion.

**Fix:** Palette-level. Lower each canvas to ~L 0.88-0.92, start grid ~L 0.86-0.88, target total span ≥0.10 with every adjacent step ≥0.02, and _explicitly reserve the largest step for `panel→elevated`_ (target dL ~0.03-0.04). Engine guard: promote `auditSurfaceRamp`'s advisory JND warning to a hard failure for light themes (today `builtInThemes.test.ts:259` only asserts `failures.length === 0` and `console.warn`s the ramp warnings — purely advisory), add a min-span assertion (~0.09), and assert `panel→elevated` is not the smallest step. This is contrast-safe: darker surfaces _raise_ contrast against dark text, and it never touches the accent token.

### RC-2 — Interactive overlay ladder is black at dark's alphas → 5-8x weaker signal _(HIGH, verified)_

**Mechanism:** The four highest-traffic interactive fills are `withAlpha(overlayTone, alpha)` with `overlayTone` = pure black on light (themes.ts:178-181) — **not** routed through the hued `overlayBase`. On dark, white adds photons over a low-L field; on light, black subtracts over near-white where discrimination is compressed.

**Evidence:**

- overlay-hover white@0.05 dark / **black@0.03 light**; overlay-active 0.08 / **0.06**; overlay-selected 0.04 / 0.05; overlay-elevated 0.06 / 0.08.
- The two highest-traffic states (hover, active) are _weaker_ on light, exactly backwards.
- Weber contrast of overlay-hover over canvas: daintree ~47% vs the light cohort clustered tightly at **6.3-6.7%** — a ~7x deficit. OKLab dL: daintree hover +0.049 / active +0.077 vs every light theme ~−0.022 / −0.044.
- Grep confirms **zero** overrides of overlay-hover/active/selected/elevated across all 7 light themes; they all inherit dark-tuned defaults via the line-274 spread.

**Fix:** In `createDaintreeTokens`, stop tone-mirroring this ladder; derive the light alphas from a perceptual Weber target (~15-25% band over surface-canvas — dark's 47% is excessive, light's <9% invisible): roughly overlay-hover black ~0.06-0.07, overlay-active ~0.10-0.12, selected ~0.08, elevated ~0.10, scaled up once RC-1 lowers the canvases. Add a `colorValidator` floor asserting overlay-hover Weber contrast > ~12% for **both** polarities — behavioral, not a literal mirror. **Audit the siblings in the same pass:** surface-hover/surface-active (themes.ts:220-221) share the identical failure mode and several light themes override them _even weaker_ (bondi surface-hover black@0.02). Accent-safe — touches only overlay-\* alphas, never the accent color, and per-theme overrides still win.

### RC-3 — Hued tint misrouted _(REFUTED as primary; demoted to polish follow-up)_

The original claim was that the hand-set hued `overlayTint` never reaches the high-traffic interaction tokens, leaving everything "generic grey on white." Verification refuted the load-bearing premise.

- True: `semantic.ts:55` routes `overlayTint` only into `overlay-base`, which feeds only the low-traffic ambient ladder (overlay-subtle…emphasis, wash-\*).
- **False:** the claim lumped `surface-hover/active/inset` into the "stays pure black" set. In fact **6 of 7 light themes hand-override surface-hover and surface-active with hued rgba** matching their tint (bali `rgba(20,40,25,…)`, atacama `rgba(51,43,35,…)`, etc.); only bondi is neutral. The theme hue _does_ reach the primary hover surface by hand.
- **Diagnosis contradicted by its own control:** the flagship **daintree overrides none** of these tokens — they fall to engine defaults = pure **white**, _not_ its mint `#D4E8DD` — yet it looks great. If neutral-tinted interaction tokens caused the washed-out look, daintree would suffer identically. It doesn't.

**Corrected conclusion:** The real differentiator is **directional perceptual lift, not chroma routing**. A white film over a dark canvas raises L and glows (+0.110 measured); a black film over near-white lowers L by a similar magnitude (−0.073) and reads as grime. This is RC-2's territory. The genuinely-unrouted tokens (overlay-hover/active/selected/elevated, filter-selected-bg-_, wash-_) are worth re-sourcing from `overlayBase` for hue identity, **but only as a follow-up gated on RC-2** — alone it swaps black→hued-dark at the same low alpha and is imperceptible.

### RC-4 — AA contrast forces light accents dark and low-chroma → figure-ground inverts _(HIGH, verified)_

**Mechanism:** The accent is used directly as on-canvas text/icon (`text-link` = accent-primary, themes.ts:227; 6 of 7 light themes leave the default). Reaching 4.5:1 on a near-white canvas forces the accent below ~L 0.55, which simultaneously crushes chroma. The result is a dark, desaturated object sitting _below_ the surface — the inverse of dark, where the accent advances.

**Evidence (OKLCH + `contrastRatio`):**

- daintree `#36CE94` L 0.760 / C 0.151, dL **+0.546**, 8.71:1.
- Every light accent has a **negative** dL: bondi `#145A44` L 0.419 / C 0.077 (lowest chroma), dL **−0.554**; bali `#228243` dL −0.424, 4.33:1; svalbard `#2D7A96` C 0.086, dL −0.415, 4.31:1; hokkaido `#6860D4` dL −0.406, 4.48:1; atacama `#9B4B2A` dL −0.423; table-mountain `#A8456E` dL −0.423.
- Three engine amplifiers make it worse: accent-soft/muted are _lower_ on light (0.12/0.20 vs 0.18/0.30, themes.ts:97-99) — bondi's accent-soft composites to C **0.013** (visually achromatic) vs daintree 0.039; accent-hover mixes toward `#000000` on light (themes.ts:167), darkening an already-receding accent on interaction; category defaults pinned ~0.15 L darker on light.

**Corrections (verification):** Drop "search icons" as a victim — every light theme explicitly overrides search-selected-result-icon / highlight-text / match-badge to a distinct non-accent value. And serengeti ships `text-link` `#586932` (5.53:1, passes AA), so "serengeti fails AA" is true only of the _raw_ accent — serengeti pre-emptively darkened its own link, itself evidence authors are fighting this. Note there is **no** `text-link`-vs-canvas pair in `CONTRAST_PAIRS`, so the engine never warns about the receding link — that's why it slipped through.

**Fix:** Stop using the raw accent as on-canvas text on light. Render light primary affordances (CTA, active nav) as a **bright full-chroma fill (~L 0.55, C preserved) with `text-inverse` on top** so the accent advances as a bright chip — authors already half-do this (bondi `settings-nav-active-bg rgba(20,90,68,0.18)`). Where the accent must be text, derive contrast by mixing toward a _same-hue dark_, not toward neutral. Flip accent-hover to brighten on light. **Accent-restraint guard:** raising accent-soft/muted is fine _only_ if those fills stay low-prominence membership tints — they must not become a second accent anchor; the bright-fill CTA remains the single load-bearing accent per focus region.

### RC-5 — Shadow default is "crisp" + both depth channels mute at once _(HIGH, verified)_

**Mechanism:** `semantic.ts:7` defaults light `shadowStyle` to **crisp** — a 1-8px-radius, 0.20-0.30-alpha black profile that over near-white reads as a hard, dirty hairline (not airy lift). All 7 light themes hand-override it, but to escape the dirtiness they crater alpha to 0.04-0.12 — and at the _same moment_ the surface step that should back the shadow is anemic (RC-1). Both depth cues mute simultaneously on light while dark gets both strong: the literal mechanism behind "floats ambiguously."

**Evidence:**

- crisp floating `0 4px 8px rgba(0,0,0,0.3)`; hand-overrides go large-radius/low-alpha: bondi `0 12px 40px @0.12`, table-mountain `0 20px 56px rgba(60,48,38,0.15)`, hokkaido `0 22px 64px @0.07`, svalbard `0 18px 44px @0.05` + ambient @0.04, bali `0 24px 64px @0.10`.
- Backing surface step `panel→elevated`: daintree **+0.058** vs light **+0.009 to +0.020**.
- `material-opacity` is forced 0.9 wherever `materialBlur>0` (semantic.ts:89; every light theme sets blur 10-14), but translucent chrome over near-white shows nothing through — the glass cue is dead.

**Corrections (verification):** (1) "soft" is _not_ the dark default that ships — daintree/redwoods/etc. explicitly set **atmospheric**, and the engine's no-token dark fallback is `0 1px 3px rgba(0,0,0,0.3)`. Frame the contrast as **crisp-light vs atmospheric-dark**. (2) The "crisp forces the override" story is only true for the crisp themes — **svalbard and bali already set `atmospheric` and still crater alpha to 0.04-0.10**, proving the alpha-crater + missing surface backbone is the real failure, with crisp an aggravator. (3) Scope: surfaces pass verbatim through the engine, so the anemic light step is a **per-palette authoring choice** — bumping shadow alphas in the switch will _not_ fix the surface channel; that needs editing elevated hexes per palette or an engine-side min-elevation-delta clamp.

**Fix:** Add a real light-tuned profile to the `shadowStyle` switch (semantic.ts:9-32) and make it the light default: large-radius, low-but-present alpha (~0.10-0.14), cool/hued ink — e.g. ambient `0 8px 24px`, floating `0 18px 48px`, dialog `0 28px 64px`. Keep "crisp" as explicit opt-in. Treat the two channels as a budget — when the surface step is small, the shadow carries more. Gate `material-opacity` to opaque on light. Accent-safe and within the alpha band other themes already use.

### RC-6 — Borders halved and unconstrained _(MEDIUM, verified)_

**Mechanism:** When overlay/shadow die on light, separation falls to borders — but the engine _under-powers_ them. themes.ts:163 halves border-interactive (white@0.20 dark vs **black@0.10 light**) and weakens border-divider (0.05→0.04). `border-default` isn't engine-derived at all (`palette.border` straight through, semantic.ts:44) and has **no audit** — `CONTRAST_PAIRS` covers no border-vs-surface pair.

**Evidence (composited contrast):** daintree border-interactive 1.90 vs bondi 1.25, table-mountain 1.20, hokkaido 1.11. hokkaido hand-set divider/subtle to 0.025/0.028 — _below_ the engine light default ("tuned every border down"). `border-default` vs elevated ranges **2.01 (svalbard) to 1.14 (bali)** — 1.76x variance. The two themes deriving border-interactive from a saturated accent do best (bali accent@0.22 = 1.33, atacama @0.16 = 1.35). The light-only 2px `panel-state-edge` (themes.ts:249) is the engine admitting soft cues don't survive inversion.

**Corrections:** "Pure black at low alpha" overstates the cohort — only bondi and the engine default use `rgba(0,0,0,…)`; table-mountain, hokkaido, svalbard, serengeti, bali, atacama already override with _hued dark tones_. The defect is the under-powered **alpha** ladder, not the hue. And borders aren't the _only_ remaining channel — the surface ramp also flattens (RC-1) — they're the most fixable one.

**Fix:** In themes.ts:160-163 raise the light branch to perceptually equalize (not alpha-equalize), **floor-driven** via `contrastRatio` (target ≥~1.18 vs the brightest adjacent surface): interactive 0.10→~0.18-0.22, divider 0.04→~0.085 (a fixed 0.08 lands at 1.17, just under), subtle 0.05→~0.09, strong 0.14→~0.18. Derive from a cool/hued dark tone (mirroring bali/atacama — composited, those resolve to near-neutral C 0.010-0.038, **not** an accent highlight, so accent-restraint is intact). Add a border-separation audit alongside `auditSurfaceRamp`; correct hokkaido's outlier-low overrides upward. No WCAG ceiling exists for borders, so raising can't break contrast.

### RC-7 — Status/diff/category fills cluster muddy _(REFUTED as causal; descriptive only)_

The numbers are accurate but the causal claim — that contrast pressure forces statuses dark — is wrong.

- True: bondi success/warning/danger/info cluster at L 0.437 / 0.446 / 0.452 / 0.395 (spread 0.057); atacama info C 0.025. Engine alphas confirmed lower on light (diff 0.18→0.10, status-danger-surface 0.10→0.08, search-highlight 0.20→0.12).
- **Refuted:** `contrast.ts:30-47` already targets only **3.0:1** (non-text) for status colors, and bondi's statuses clear it by **2-3x** (success 7.31, info 9.00). There is _no_ contrast pressure pinning them dark — the deep, low-chroma values are **authored into each palette** and pass through untouched (semantic.ts:47-50). "The engine does the opposite" is false; the engine doesn't constrain these at all.
- **Refuted:** remediation lever "relax to 3:1" is a no-op (already 3:1, cleared by 2-3x).
- **Partially refuted:** the insert/delete fill collapse is _not_ light-specific — dark daintree gives insert dL +0.075 / delete +0.082 (Δ −0.006), chroma equally crushed. The full-chroma **diff gutter** is the real per-line cue on both modes; light's genuine deficit is only smaller fill magnitude.

**Citation fixes:** search-highlight = **themes.ts:113** (not semantic.ts); categoryDefaults = **themes.ts:127-155**.

**Corrected fix:** **Re-author** the light palettes' status/activity hues brighter and more saturated using the existing headroom (toward L ~0.58-0.64, higher C) — don't touch the contrast target. Still raise light-branch alphas on diff/danger/search _surface_ fills (themes.ts:258-273, 113) to clear a JND, but don't sell it as fixing insert/delete confusion (the gutter does that). Category L-raise toward 0.58-0.62 / C ≥0.13 is safe (no category contrast guard).

### RC-8 — Syntax/muted text validated against the dark terminal, rendered on the light canvas _(MEDIUM, verified)_

**Mechanism:** `contrast.ts` `getTerminalSyntaxWarnings` validates syntax roles only against `terminal-background` (always dark, rationale at lines 456-457), but `editorTheme.ts:6` paints `--theme-syntax-*` on `var(--theme-surface-canvas)`. For light themes the validation surface (dark terminal) ≠ the render surface (near-white canvas). For daintree there's no terminal override, so it falls back to the canvas — validation surface == render surface, so daintree passes both.

**Evidence (repo math):** syntax on canvas — table-mountain punctuation `#b8c4d0` **1.56:1**, bondi number `#F5B814` 1.65:1, bali punctuation 1.70:1. text-muted on canvas: bondi 2.86, table-mountain 2.90, svalbard 2.96, bali `#788C76` 3.23 (fails AA), serengeti 3.84 vs daintree 5.13 — and `text-muted` is in **no** `CONTRAST_PAIRS` entry. CodeMirror comments map to `activity-idle` (editorTheme.ts:23, hokkaido 2.25 on canvas), also unchecked. `text-placeholder` = text-primary @0.32 (themes.ts:225) composites to ~1.97:1. Secondary/muted chroma drains to C 0.012-0.020 (near-neutral grey). And **editorTheme.ts:31 hardcodes `theme: "dark"`** even for light palettes.

**Corrections:** "muted fails 3:1 on light" is overstated — precisely, muted fails _AA (4.5)_ on every light theme and dips below 3:1 only on bondi/table-mountain/svalbard. `visual-guide.md:738-739` explicitly _sanctions_ sub-AA muted and 32-35% placeholder, so frame this as a light-vs-dark **calibration asymmetry**, not an unintended bug (daintree's own muted is also low — activity-idle 2.27 — so this is about the light branch's collapse, not dark being universally compliant).

**Fix:** Derive an editor-syntax set re-darkened in OKLCH to ≥4.5:1 against surface-canvas for light, point `editorTheme.ts` at it, add a syntax-vs-surface-canvas check to the validator (validate against the _render_ surface in addition to terminal-background). Add `text-muted` to `CONTRAST_PAIRS` (a floor nearer 3.5-4.0 is more honest than 3.0). Point CodeMirror comments at `syntax-comment`, raise placeholder alpha (state the _target ratio_, not just the alpha — ~0.50 lands ~2.6-3.0:1, needs ~0.55-0.60 for a hard 3:1). Derive `theme` per `palette.type` at editorTheme.ts:31. When darkening any role, lift chroma ~0.02-0.04 — but bound it by `DISTINCTNESS_PAIRS` (contrast.ts:242-254) so re-chroma'd roles don't collide. Accent-safe.

### RC-9 — Frosted-glass material inert on light _(LOW, verified)_

**Mechanism:** `chrome-noise-texture` bakes a hardcoded **white** radial gradient (semantic.ts:91-94, duplicated themes.ts:717-719) for both types — invisible over near-white, and no light theme sets `noiseOpacity` so it resolves to `"none"` anyway. `material-opacity` is computed but **dead code** — `--theme-material-opacity` appears only in tests/engine, never in CSS; real translucency is hardcoded (panels.css 95%, index.css 94%, and surface-toolbar is _fully opaque_). `saturate(115%)` is multiplicative on near-zero chroma; blur averages near-white into near-white.

**Fix (polish only):** Make noise color type-aware (dark/hued-near-black on light, very low opacity ~0.015-0.03 like highlands). Wire `--theme-material-opacity` into surface backgrounds and lower it on light (~0.78-0.85) — **contrast-gated** (verify body text over any more-transparent panel still meets AA; keep the existing reduced-transparency/contrast fallbacks). A _modest_ saturation bump (~120-125%) + `brightness(~0.97)`, not 130-160% — heavy saturate amplifies all chroma behind the glass and risks the accent-restraint rule. Touch both duplicated code paths.

## 4. The fix strategy (impact-to-effort)

**Engine changes (`shared/theme/themes.ts` / `semantic.ts`) — broad, one-time, cheap:**

1. **RC-5 shadow profile** — add a light-tuned `shadowStyle` (large-radius, ~0.10-0.14 cool-hued ink), make it the light default, gate `material-opacity` opaque on light. Removes the need for all 7 themes to re-author shadows. _Highest impact-to-effort._
2. **RC-2 overlay alphas** — derive the four interactive fills (+ surface-hover/active siblings) from a Weber target instead of mirroring black@dark-alphas; add a both-polarity validator floor.
3. **RC-6 border alphas** — floor-driven light branch (interactive 0.10→~0.20, divider →~0.085, subtle →~0.09, strong →~0.18), hued dark tone; add a border-separation audit.
4. **RC-1 guard** — promote `auditSurfaceRamp` JND to a hard failure for light, add min-span (~0.09) + "panel→elevated not smallest" assertions.

**Per-theme palette retuning — necessary but theme-by-theme:**

5. **RC-1 ramps** — lower canvases to L ~0.88-0.92, widen spans to ≥0.10, reserve the largest step for `panel→elevated`. bondi: 0.951/0.958/0.973/0.988/1.000 → ~0.88/0.91/0.94/0.96/0.99.
6. **RC-4 accents** — render CTAs/active-nav as bright full-chroma fills with `text-inverse`; flip accent-hover to brighten on light. _Must respect accent-restraint — one load-bearing accent per focus region; the soft/muted fills must stay membership tints, not a second anchor._
7. **RC-7 statuses** — re-author hues brighter/more saturated (L ~0.58-0.64) into each palette.
8. **RC-8 syntax/text** — derive a light editor-syntax set ≥4.5:1 on canvas, fix `editorTheme.ts` theme/comment mapping, add validator pairs.

**Sequencing:** RC-1 must land before gating `surface-input → surface-panel-elevated` on light (themes.ts:218) — that's only valid once a real elevated lift exists. RC-3 hue-routing is a **polish follow-up gated on RC-2**, not an independent fix. RC-9 is last.

## 5. Quick wins vs deeper work

**Quick wins (engine, ship first — cheap, high-impact, all themes at once):**

- RC-5 light shadow profile + opaque light material (one switch case, one default flip).
- RC-2 overlay/surface-hover alpha re-derivation + validator floor.
- RC-6 border alpha floor + audit.
- RC-1 audit promotion (catches regressions immediately).

**Deeper work (per-theme, slower):**

- RC-1 surface-ramp re-authoring across all 7 palettes — the structural prerequisite; until canvases drop, the engine quick-wins have limited headroom.
- RC-4 accent-as-fill redesign per theme (respecting accent-restraint).
- RC-7 status/activity re-authoring; RC-8 light editor-syntax derivation + `editorTheme.ts` fixes.
- RC-3 hue-routing and RC-9 material polish, last.

**Bottom line:** the machinery is correct and dark-optimal; light needs a _lower, wider surface ramp_ and _accents kept saturated_ before the overlay/shadow/border machinery has any luminance room to work. The engine quick-wins (RC-2/5/6) buy visible improvement immediately; the per-theme ramp + accent retuning (RC-1/4) is what closes the gap to the dark flagship.

## Per-theme severity (1 fine → 10 badly washed out)

bondi 8 · hokkaido 8 · serengeti 8 · bali 7 · svalbard 7 · table-mountain 6 · atacama 5
