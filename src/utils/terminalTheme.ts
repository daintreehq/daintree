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
  voiceCursor: string;
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
  /** The keyboard-focus outline: accent, mixed into the background no further than 3:1 allows. */
  shellFocusRing: string;
  /** The `❯` marker, at rest and on the selected composer. */
  marker: string;
  markerSelected: string;
  /** Placeholder ink, fitted to 4.5:1 against the fills it sits on. */
  placeholder: string;
  placeholderSelected: string;
  placeholderMore: string;
  isDark: boolean;
}

type Rgb = readonly [number, number, number];

const BLACK: Rgb = [0, 0, 0];

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
  if (fg && bg) {
    const rest = mixOklab(bg, BLACK, restDim);
    const hover = mixOklab(bg, BLACK, hoverDim);
    const selected = mixOklab(fg, bg, 0.03);
    placeholderPct = fitMix(fg, bg, 48, 4.6, [rest, hover]) ?? 100;
    placeholderSelectedPct = Math.min(
      100,
      Math.max(placeholderPct + 6, fitMix(fg, bg, 48, 4.6, [selected]) ?? 100)
    );
    if (acInk) {
      const ringPct = fitMix(acInk.rgb, bg, 60, 3.1, [bg]);
      // A cursor too close to its background (Rosé Pine Dawn's) cannot reach
      // 3:1 at any strength. Lean it toward the foreground until it does,
      // keeping as much of its hue as the floor allows.
      focusRing =
        ringPct !== null
          ? mix(acInk.css, ringPct, background)
          : mix(fgCss, fitMix(fg, acInk.rgb, 0, 3.1, [bg]) ?? 100, acInk.css);
    }
  }

  return {
    accent,
    foreground,
    background,
    selectionBg: theme.selectionBackground ?? theme.cursor ?? "#264f78",
    chipColor: theme.cyan ?? theme.brightCyan ?? theme.cursor ?? "#58a6ff",
    errorColor: theme.red ?? "#f44747",
    successColor: theme.green ?? "#89d185",
    voiceCursor: theme.yellow ?? theme.brightYellow ?? "#e5c07b",
    shellBg: mix(background, restDim * 100, "black"),
    shellBorder: mix(foreground, isDark ? 7 : 9, "transparent"),
    shellBorderHover: mix(foreground, isDark ? 11 : 14, "transparent"),
    shellShadow: isDark ? "0 1px 3px rgba(0,0,0,0.15)" : "0 1px 3px rgba(0,0,0,0.05)",
    shellHoverBg: mix(background, hoverDim * 100, "black"),
    shellSelectedBg: mix(fgCss, 3, background),
    shellBorderSelected: mix(fgCss, 24, background),
    shellFocusRing: focusRing,
    marker: "color-mix(in oklab, var(--ib-fg) 72%, var(--ib-bg))",
    markerSelected: "color-mix(in oklab, var(--ib-fg) 90%, var(--ib-bg))",
    placeholder: mix(fgCss, placeholderPct, background),
    placeholderSelected: mix(fgCss, placeholderSelectedPct, background),
    placeholderMore: mix(fgCss, Math.max(85, placeholderSelectedPct), background),
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
