import type { ITheme } from "@xterm/xterm";
import {
  BUILT_IN_APP_SCHEMES,
  DEFAULT_APP_SCHEME_ID,
  getTerminalThemeFromAppScheme,
  getTerminalScrollbarDefaults,
  TRANSPARENT_OVERVIEW_RULER_BORDER,
} from "@shared/theme";

const DEFAULT_APP_SCHEME =
  BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === DEFAULT_APP_SCHEME_ID) ??
  BUILT_IN_APP_SCHEMES[0]!;

export const DAINTREE_TERMINAL_THEME = getTerminalThemeFromAppScheme(DEFAULT_APP_SCHEME);

export interface InputBarColors {
  // Terminal-derived (text & accent match the terminal)
  accent: string;
  foreground: string;
  background: string;
  selectionBg: string;
  chipColor: string;
  errorColor: string;
  successColor: string;
  // The shell, also from the terminal palette: a terminal stays dark under a
  // light app theme, and app tokens land dark-on-dark on it.
  shellBg: string;
  shellBorder: string;
  shellBorderHover: string;
  shellShadow: string;
  shellHoverBg: string;
  /**
   * The composer whose pane is selected, keyboard elsewhere. Neutral, never
   * accent: the accent says the keyboard is in the composer, and a selected
   * pane whose keystrokes go to its terminal must not claim that.
   */
  shellSelectedBg: string;
  shellBorderSelected: string;
  /** The editor's scrollbar thumb, fitted to 3:1 against the shell's fills. */
  scrollThumb: string;
  /** The typing caret: the terminal's cursor, leaned to 3:1 where it cannot reach it. */
  caretInk: string;
  /** A staged chip's contour, fitted to 3:1 against the shell's fills. */
  chipStagedBorder: string;
  /** The keyboard-focus outline: accent, mixed into the background no further than 3:1 allows. */
  shellFocusRing: string;
  /** The `❯` marker, at rest and on the selected composer. */
  marker: string;
  markerSelected: string;
  /**
   * The draft's ink: the terminal's foreground, or, on a palette whose own
   * foreground can't reach 4.5:1 on the shell (Solarized Light's sits at
   * 3.95:1), that foreground leaned toward black or white just far enough.
   * The placeholder, pill and reference inks build on it.
   */
  textInk: string;
  /**
   * How much foreground the shell's controls mix into its fill: 72% wherever
   * that clears 3:1 on the resting, hovered and selected shell, and more on a
   * palette whose foreground sits close to its background (Solarized Light).
   */
  controlMix: string;
  /**
   * `/command` and `@file` ink: the palette's cyan where it reads at 4.5:1 on
   * every shell fill and the staged-for-delete fill, leaned toward the pill
   * label's ink only as far as that needs.
   */
  referenceInk: string;
  /**
   * A pill chip's label: the draft's ink, leaned further only where the pill's
   * own wash (10% foreground) or its staged fill (16%) costs it the floor.
   */
  chipText: string;
  /** How much of `chipText` a pill's remove × mixes into the shell: 3:1 on every pill fill. */
  chipControlMix: string;
  /** Placeholder ink, fitted to 4.5:1 against the fills it sits on. */
  placeholder: string;
  placeholderSelected: string;
  placeholderMore: string;
  /**
   * Dictated words not yet written into the draft, and a cleanup streaming
   * over them until it lands, fitted to 4.5:1 against the resting shell and
   * the listening fill: they are the user's words, only provisional, so the
   * italic says so and the ink stays readable.
   */
  interim: string;
  /**
   * A voice send's progress: the bar along the shell's foot. Neutral, as
   * progress is status and the shell's perimeter already spends the accent.
   * Fitted to 3:1 against the shell, resting and selected, and the pane
   * around it.
   */
  waitEdge: string;
  /** The wait's caption, on the border: fitted to 4.5:1 over the pane, the shell and the wash. */
  waitCaption: string;
  /**
   * The mic's listening orbit. The shell's own accent, so the orbit and the
   * listening shell around it are one signal in one hue, leaned toward the
   * foreground only as far as 3:1 against the listening fill and the mic's
   * disc needs: it is the one mark that says the mic is hearing.
   */
  voiceSignal: string;
  /**
   * The ring round a paused mic: neutral, as a pause is the user's and not a
   * signal, fitted to 3:1 against the mic's disc at rest and hovered.
   */
  voiceHeld: string;
  /**
   * The live insertion caret's quietest opacity, 0.55 to 1: the level's floor,
   * raised where 0.55 would leave the caret under 3:1 against the listening fill.
   */
  voiceCaretFloor: number;
  isDark: boolean;
}

/**
 * A pill chip's wash, and its fill once staged for delete (`base.ts`). The
 * staged fill is opaque over the shell; at 16 it landed on the same value as
 * the translucent wash, so only the contour said which chip was staged.
 */
export const CHIP_WASH_MIX = 10;
export const CHIP_STAGED_MIX = 22;

/** How much accent the listening shell's fill carries (`HybridInputBar`). */
export const VOICE_LISTENING_FILL_MIX = 12;

/** The mic's disc over the shell's fill, at rest and hovered (`VoiceInputButton`). */
const VOICE_DISC_MIXES = [12, 18] as const;

/** The orbit's dot at the quietest a listening voice leaves it (`VoiceInputButton`). */
export const VOICE_ORBIT_MIN_OPACITY = 0.82;

/** The live insertion caret at the quietest a voice leaves it, before contrast fitting. */
const VOICE_CARET_MIN_OPACITY = 0.55;

type Rgb = readonly [number, number, number];

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [1, 1, 1];

interface ParsedColor {
  rgb: Rgb;
  alpha: number;
}

const unit = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Hex or `rgb()`/`rgba()` to sRGB 0–1 plus alpha, clamped the way CSS clamps
 * them; anything else (named colours, `var()`) is not ours to guess.
 */
function parseColor(value: string): ParsedColor | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b, a] = [0, 2, 4, 6].map((i) => parseInt(full.slice(i, i + 2) || "ff", 16) / 255);
    return { rgb: [r!, g!, b!], alpha: a! };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?/i.exec(v);
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map((c) => Number(c) / 255);
    const alpha = fn[4] === undefined ? 1 : Number(fn[4]) / (fn[5] ? 100 : 1);
    if (![r, g, b, alpha].every(Number.isFinite)) return null;
    return { rgb: [unit(r!), unit(g!), unit(b!)], alpha: unit(alpha) };
  }
  return null;
}

const toHex = (rgb: Rgb) =>
  `#${rgb
    .map((c) =>
      Math.round(unit(c) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;

function toOklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (c: number) => Math.min(1, Math.max(0, fromLinear(c)));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** `x` at `alpha` painted over opaque `y`, as the compositor blends it. */
function over(x: Rgb, y: Rgb, alpha: number): Rgb {
  const blend = (i: 0 | 1 | 2) => x[i] * alpha + y[i] * (1 - alpha);
  return [blend(0), blend(1), blend(2)];
}

/** What `color-mix(in oklab, x p%, y)` paints, for opaque x and y. */
function mixOklab(x: Rgb, y: Rgb, p: number): Rgb {
  const [a, b] = [toOklab(x), toOklab(y)];
  const lerp = (i: 0 | 1 | 2) => a[i] * p + b[i] * (1 - p);
  return fromOklab([lerp(0), lerp(1), lerp(2)]);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(x: Rgb, y: Rgb): number {
  const [a, b] = [luminance(x), luminance(y)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The smallest whole percentage of `ink` mixed into `base` that reaches
 * `target` against every surface, starting from `from`, or null when even the
 * pure ink falls short. A fixed percentage lands anywhere from comfortable to
 * illegible across terminal palettes; the fit keeps each one as quiet as the
 * floor allows, so every theme reads alike.
 */
function fitMix(ink: Rgb, base: Rgb, from: number, target: number, surfaces: Rgb[]): number | null {
  for (let p = from; p <= 100; p++) {
    const painted = mixOklab(ink, base, p / 100);
    if (surfaces.every((s) => contrast(painted, s) >= target)) return p;
  }
  return null;
}

export function resolveInputBarColors(theme: ITheme): InputBarColors {
  const accent = theme.cursor ?? theme.blue ?? "#58a6ff";
  const foreground = theme.foreground ?? "#cccccc";
  const background = theme.background ?? "#1e1e1e";
  const chipColor = theme.cyan ?? theme.brightCyan ?? theme.cursor ?? "#58a6ff";

  // A translucent background has no one colour to fit against. A translucent
  // ink paints as its composite over the background, so that is what is
  // fitted, and what is emitted, or the fit would be measuring a colour the
  // shell never shows.
  const bgParsed = parseColor(background);
  const bg = bgParsed && bgParsed.alpha === 1 ? bgParsed.rgb : null;
  const solid = (raw: string): { rgb: Rgb; css: string } | null => {
    const parsed = parseColor(raw);
    if (!parsed || !bg) return null;
    if (parsed.alpha === 1) return { rgb: parsed.rgb, css: raw };
    const over = (i: 0 | 1 | 2) => parsed.rgb[i] * parsed.alpha + bg[i] * (1 - parsed.alpha);
    const rgb: Rgb = [over(0), over(1), over(2)];
    return { rgb, css: toHex(rgb) };
  };
  const fgInk = solid(foreground);
  const acInk = solid(accent);
  const fg = fgInk?.rgb ?? null;
  // The terminal's own polarity, not the app's: a light app theme keeps a dark
  // terminal, and branching on the app mode mixed a dark shell's focus edge
  // toward black.
  const isDark =
    fg && bg
      ? luminance(bg) < luminance(fg)
      : (document?.documentElement?.dataset?.colorMode ?? "dark") === "dark";

  const restDim = isDark ? 0.98 : 0.985;
  const hoverDim = isDark ? 0.955 : 0.965;
  const mix = (x: string, p: number, y: string) => `color-mix(in oklab, ${x} ${p}%, ${y})`;

  // Fallbacks for a palette we cannot parse: the old fixed recipe.
  const fgCss = fgInk?.css ?? foreground;
  let focusRing = mix(acInk?.css ?? accent, 60, background);
  let placeholderPct = 67;
  let placeholderSelectedPct = 72;
  let interimPct = 67;
  let waitEdgePct = 60;
  let waitCaptionPct = 72;
  let voiceSignal = acInk?.css ?? accent;
  let voiceHeldPct = 60;
  let voiceCaretFloor = VOICE_CARET_MIN_OPACITY;
  let controlPct = 72;
  let referenceInk = chipColor;
  let textInk = fgCss;
  let chipText = fgCss;
  let chipControlPct = 72;
  let borderSelectedPct = 24;
  let scrollThumbPct = 40;
  let caretInk = accent;
  let stagedBorderPct = 55;
  if (fg && bg) {
    const rest = mixOklab(bg, BLACK, restDim);
    const hover = mixOklab(bg, BLACK, hoverDim);
    const selected = mixOklab(fg, bg, 0.03);
    const shells = [rest, hover, selected];
    let ink = fg;
    if (!shells.every((s) => contrast(fg, s) >= 4.6)) {
      const pole = isDark ? WHITE : BLACK;
      for (let p = 1; p <= 100; p++) {
        const leaned = mixOklab(pole, fg, p / 100);
        if (shells.every((s) => contrast(leaned, s) >= 4.6)) {
          ink = leaned;
          break;
        }
      }
      textInk = toHex(ink);
    }
    placeholderPct = fitMix(ink, bg, 48, 4.6, [rest, hover]) ?? 100;
    // The selected edge is what finds the selected composer among several;
    // 24% is the look, with a floor for palettes whose foreground sits close
    // to the background, measured against both fills it divides.
    borderSelectedPct = fitMix(fg, bg, 24, 1.8, [bg, selected]) ?? 24;
    // The editor's scrollbar thumb at the height cap: a control, so 3:1 against
    // every fill the shell takes.
    scrollThumbPct = fitMix(fg, bg, 28, 3.1, shells) ?? 100;
    // The controls mix toward the shell's own fill (`--ib-bg`), which is the
    // selected fill on the selected composer, so each fill is fitted with its
    // own mix; a hovered shell keeps the resting mix under a lighter fill.
    controlPct = 100;
    for (let p = 72; p <= 100; p++) {
      const onRest = mixOklab(fg, rest, p / 100);
      const onSelected = mixOklab(fg, selected, p / 100);
      if (
        contrast(onRest, rest) >= 3.1 &&
        contrast(onRest, hover) >= 3.1 &&
        contrast(onSelected, selected) >= 3.1
      ) {
        controlPct = p;
        break;
      }
    }
    // What a chip paints on: a pill's translucent wash over each shell fill
    // (`chipStyle`), and the opaque fill of a chip staged by Backspace.
    const staged = mixOklab(fg, rest, CHIP_STAGED_MIX / 100);
    const pills = [...shells.map((s) => over(fg, s, CHIP_WASH_MIX / 100)), staged];
    // A staged chip's contour is what says which chip Backspace will take (the
    // caret hides while one is staged): 3:1 against the shell around it.
    stagedBorderPct = fitMix(fg, rest, 55, 3.1, shells) ?? 100;
    let label = ink;
    if (!pills.every((s) => contrast(ink, s) >= 4.6)) {
      const pole = isDark ? WHITE : BLACK;
      label = pole;
      for (let p = 1; p <= 100; p++) {
        const leaned = mixOklab(pole, ink, p / 100);
        if (pills.every((s) => contrast(leaned, s) >= 4.6)) {
          label = leaned;
          break;
        }
      }
      chipText = toHex(label);
    } else if (ink !== fg) {
      chipText = textInk;
    }
    // Leaned toward the pill label, which clears the shells and the staged
    // fill by construction, so the fit always lands and never falls back to
    // the raw cyan.
    const chipInk = solid(chipColor);
    if (chipInk) {
      const surfaces = [...shells, staged];
      referenceInk = toHex(label);
      for (let p = 0; p <= 100; p++) {
        const leaned = mixOklab(label, chipInk.rgb, p / 100);
        if (surfaces.every((s) => contrast(leaned, s) >= 4.6)) {
          referenceInk = p === 0 ? chipInk.css : toHex(leaned);
          break;
        }
      }
    }
    chipControlPct = 100;
    for (let p = 72; p <= 100; p++) {
      const glyph = mixOklab(label, rest, p / 100);
      if (pills.every((s) => contrast(glyph, s) >= 3.1)) {
        chipControlPct = p;
        break;
      }
    }
    placeholderSelectedPct = Math.min(
      100,
      Math.max(placeholderPct + 6, fitMix(ink, bg, 48, 4.6, [selected]) ?? 100)
    );
    const listeningFill = acInk ? [mixOklab(acInk.rgb, bg, VOICE_LISTENING_FILL_MIX / 100)] : [];
    interimPct = fitMix(fg, bg, 48, 4.6, [rest, ...listeningFill]) ?? 100;
    waitEdgePct = fitMix(fg, bg, 40, 3.1, [rest, selected, bg]) ?? 100;
    waitCaptionPct = fitMix(fg, bg, 48, 4.6, [rest, selected, bg]) ?? 100;
    voiceHeldPct =
      fitMix(
        fg,
        bg,
        40,
        3.1,
        VOICE_DISC_MIXES.map((p) => over(fg, rest, p / 100))
      ) ?? 100;
    if (acInk) {
      const ringPct = fitMix(acInk.rgb, bg, 60, 3.1, [bg]);
      // A cursor too close to its background (Rosé Pine Dawn's) cannot reach
      // 3:1 at any strength. Lean it toward the foreground until it does,
      // keeping as much of its hue as the floor allows.
      focusRing =
        ringPct !== null
          ? mix(acInk.css, ringPct, background)
          : mix(fgCss, fitMix(fg, acInk.rgb, 0, 3.1, [bg]) ?? 100, acInk.css);
      // The typing caret and drop cursor take the same lean against the shell's
      // fills, so the one mark that says where typing goes never fades out.
      if (!shells.every((s) => contrast(acInk.rgb, s) >= 3.1)) {
        caretInk = mix(fgCss, fitMix(fg, acInk.rgb, 0, 3.1, shells) ?? 100, acInk.css);
      }
      // The disc is the foreground at low alpha over the listening fill, and
      // the dot is the signal at its quietest opacity over the disc: fit what
      // the compositor actually paints, not the opaque inks.
      const listening = mixOklab(acInk.rgb, bg, VOICE_LISTENING_FILL_MIX / 100);
      const discs = VOICE_DISC_MIXES.map((p) => over(fg, listening, p / 100));
      // A palette that cannot reach 3:1 at any lean goes all the way to the
      // foreground, as every other fit here does.
      let lean = 100;
      for (let p = 0; p < 100; p++) {
        const ink = mixOklab(fg, acInk.rgb, p / 100);
        const reads = discs.every(
          (disc) => contrast(over(ink, disc, VOICE_ORBIT_MIN_OPACITY), disc) >= 3.1
        );
        if (reads) {
          lean = p;
          break;
        }
      }
      // Emitted as a resolved colour: the orbit derives its alpha steps from it
      // with relative colour syntax, once per frame.
      const signal = mixOklab(fg, acInk.rgb, lean / 100);
      if (lean > 0) voiceSignal = toHex(signal);
      // The insertion caret dims further with a quiet voice than the orbit
      // does. Raise its floor only where the quietest step would drop under
      // 3:1 against the listening fill, keeping the hue it shares with the orbit.
      voiceCaretFloor = 1;
      for (let p = Math.round(VOICE_CARET_MIN_OPACITY * 100); p <= 100; p++) {
        if (contrast(over(signal, listening, p / 100), listening) >= 3.1) {
          voiceCaretFloor = p / 100;
          break;
        }
      }
    }
  }

  return {
    accent,
    foreground,
    background,
    selectionBg: theme.selectionBackground ?? theme.cursor ?? "#264f78",
    chipColor,
    errorColor: theme.red ?? "#f44747",
    successColor: theme.green ?? "#89d185",
    shellBg: mix(background, restDim * 100, "black"),
    shellBorder: mix(foreground, isDark ? 7 : 9, "transparent"),
    shellBorderHover: mix(foreground, isDark ? 11 : 14, "transparent"),
    shellShadow: isDark ? "0 1px 3px rgba(0,0,0,0.15)" : "0 1px 3px rgba(0,0,0,0.05)",
    shellHoverBg: mix(background, hoverDim * 100, "black"),
    shellSelectedBg: mix(fgCss, 3, background),
    shellBorderSelected: mix(fgCss, borderSelectedPct, background),
    shellFocusRing: focusRing,
    // The resting `❯` wears the control ink, fitted to 3:1 like the controls;
    // the selected one stays a clear step above it.
    marker: `color-mix(in oklab, var(--ib-fg) ${controlPct}%, var(--ib-bg))`,
    markerSelected: `color-mix(in oklab, var(--ib-fg) ${Math.min(100, Math.max(90, controlPct + 12))}%, var(--ib-bg))`,
    scrollThumb: mix(fgCss, scrollThumbPct, background),
    caretInk,
    chipStagedBorder: mix(fgCss, stagedBorderPct, mix(background, restDim * 100, "black")),
    textInk,
    controlMix: `${controlPct}%`,
    referenceInk,
    chipText,
    chipControlMix: `${chipControlPct}%`,
    placeholder: mix(textInk, placeholderPct, background),
    placeholderSelected: mix(textInk, placeholderSelectedPct, background),
    placeholderMore: mix(fgCss, Math.max(85, placeholderSelectedPct), background),
    interim: mix(fgCss, interimPct, background),
    waitEdge: mix(fgCss, waitEdgePct, background),
    waitCaption: mix(fgCss, waitCaptionPct, background),
    voiceSignal,
    voiceHeld: mix(fgCss, voiceHeldPct, background),
    voiceCaretFloor,
    isDark,
  };
}

/**
 * Get terminal theme from CSS custom properties.
 *
 * Background colors for TUI applications are still handled dynamically by xterm.js.
 * This function only returns the base app-aligned terminal palette.
 */
export function getTerminalThemeFromCSS(): typeof DAINTREE_TERMINAL_THEME {
  if (typeof document === "undefined") {
    return { ...DAINTREE_TERMINAL_THEME };
  }

  const styles = getComputedStyle(document.documentElement);
  const getVar = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
  };

  return {
    background: getVar("--theme-terminal-background", DAINTREE_TERMINAL_THEME.background ?? ""),
    foreground: getVar("--theme-terminal-foreground", DAINTREE_TERMINAL_THEME.foreground ?? ""),
    // Transparent so xterm's overview ruler outline (white by default in xterm
    // 6.0) never paints a strip on the right edge, theme- or app-coloured.
    overviewRulerBorder: TRANSPARENT_OVERVIEW_RULER_BORDER,
    cursor: getVar("--theme-accent-primary", DAINTREE_TERMINAL_THEME.cursor ?? ""),
    cursorAccent: getVar("--theme-text-inverse", DAINTREE_TERMINAL_THEME.cursorAccent ?? ""),
    selectionBackground: getVar(
      "--theme-terminal-selection",
      DAINTREE_TERMINAL_THEME.selectionBackground ?? ""
    ),
    selectionForeground: getVar(
      "--theme-terminal-foreground",
      DAINTREE_TERMINAL_THEME.selectionForeground ?? ""
    ),
    black: getVar("--theme-terminal-black", DAINTREE_TERMINAL_THEME.black ?? ""),
    red: getVar("--theme-terminal-red", DAINTREE_TERMINAL_THEME.red ?? ""),
    green: getVar("--theme-terminal-green", DAINTREE_TERMINAL_THEME.green ?? ""),
    yellow: getVar("--theme-terminal-yellow", DAINTREE_TERMINAL_THEME.yellow ?? ""),
    blue: getVar("--theme-terminal-blue", DAINTREE_TERMINAL_THEME.blue ?? ""),
    magenta: getVar("--theme-terminal-magenta", DAINTREE_TERMINAL_THEME.magenta ?? ""),
    cyan: getVar("--theme-terminal-cyan", DAINTREE_TERMINAL_THEME.cyan ?? ""),
    white: getVar("--theme-terminal-white", DAINTREE_TERMINAL_THEME.white ?? ""),
    brightBlack: getVar("--theme-terminal-bright-black", DAINTREE_TERMINAL_THEME.brightBlack ?? ""),
    brightRed: getVar("--theme-terminal-bright-red", DAINTREE_TERMINAL_THEME.brightRed ?? ""),
    brightGreen: getVar("--theme-terminal-bright-green", DAINTREE_TERMINAL_THEME.brightGreen ?? ""),
    brightYellow: getVar(
      "--theme-terminal-bright-yellow",
      DAINTREE_TERMINAL_THEME.brightYellow ?? ""
    ),
    brightBlue: getVar("--theme-terminal-bright-blue", DAINTREE_TERMINAL_THEME.brightBlue ?? ""),
    brightMagenta: getVar(
      "--theme-terminal-bright-magenta",
      DAINTREE_TERMINAL_THEME.brightMagenta ?? ""
    ),
    brightCyan: getVar("--theme-terminal-bright-cyan", DAINTREE_TERMINAL_THEME.brightCyan ?? ""),
    brightWhite: getVar("--theme-terminal-bright-white", DAINTREE_TERMINAL_THEME.brightWhite ?? ""),
    ...getTerminalScrollbarDefaults(
      (document.documentElement.dataset.colorMode as "dark" | "light") ?? "dark"
    ),
  };
}
