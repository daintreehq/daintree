import { useSyncExternalStore } from "react";
import type {
  PluginDaintreeTheme,
  PluginThemeTokenKey,
  PluginThemeTokens,
} from "@shared/types/plugin-sdk-react";

// Read straight from the DOM the host already themes (`applyAppThemeToRoot`
// writes every `--theme-*` token inline on <html>, plus `data-theme` and
// `data-color-mode`), so this module stays React-only: importing the theme
// store here would drag app code into the facade chunk.

// A record, not an array, so a key added to the public union without a
// runtime entry (or the reverse) fails typecheck. Also the seed every
// resolution copies, so a token the document lacks reads as "".
const EMPTY_TOKENS: Record<PluginThemeTokenKey, string> = {
  "surface-grid": "",
  "surface-sidebar": "",
  "surface-canvas": "",
  "surface-panel": "",
  "surface-panel-elevated": "",
  "surface-input": "",
  "surface-inset": "",
  "surface-hover": "",
  "surface-active": "",
  "text-primary": "",
  "text-secondary": "",
  "text-muted": "",
  "text-placeholder": "",
  "text-inverse": "",
  "text-link": "",
  "border-default": "",
  "border-subtle": "",
  "border-strong": "",
  "border-divider": "",
  "border-interactive": "",
  "accent-primary": "",
  "accent-foreground": "",
  "accent-hover": "",
  "accent-soft": "",
  "accent-muted": "",
  "focus-ring": "",
  "status-success": "",
  "status-warning": "",
  "status-danger": "",
  "status-info": "",
  "activity-active": "",
  "activity-idle": "",
  "activity-working": "",
  "activity-waiting": "",
  "terminal-background": "",
  "terminal-foreground": "",
  "terminal-muted": "",
  "terminal-cursor": "",
  "terminal-selection": "",
  "terminal-black": "",
  "terminal-red": "",
  "terminal-green": "",
  "terminal-yellow": "",
  "terminal-blue": "",
  "terminal-magenta": "",
  "terminal-cyan": "",
  "terminal-white": "",
  "terminal-bright-black": "",
  "terminal-bright-red": "",
  "terminal-bright-green": "",
  "terminal-bright-yellow": "",
  "terminal-bright-blue": "",
  "terminal-bright-magenta": "",
  "terminal-bright-cyan": "",
  "terminal-bright-white": "",
  "syntax-comment": "",
  "syntax-punctuation": "",
  "syntax-number": "",
  "syntax-string": "",
  "syntax-operator": "",
  "syntax-keyword": "",
  "syntax-function": "",
  "syntax-link": "",
  "syntax-quote": "",
  "category-blue": "",
  "category-purple": "",
  "category-cyan": "",
  "category-green": "",
  "category-amber": "",
  "category-orange": "",
  "category-teal": "",
  "category-indigo": "",
  "category-rose": "",
  "category-pink": "",
  "category-violet": "",
  "category-slate": "",
};

function isThemeTokenKey(key: string): key is PluginThemeTokenKey {
  return Object.hasOwn(EMPTY_TOKENS, key);
}

export const THEME_TOKEN_KEYS: PluginThemeTokenKey[] =
  Object.keys(EMPTY_TOKENS).filter(isThemeTokenKey);

const OBSERVED_ATTRIBUTES = ["style", "class", "data-theme", "data-color-mode", "data-colorblind"];

let cached: PluginDaintreeTheme | null = null;
let cachedSignature = "";
let observer: MutationObserver | null = null;
// One entry per registration, so registering the same function twice and
// disposing one keeps the other.
const listeners = new Set<{ listener: (theme: PluginDaintreeTheme) => void }>();
// What subscribers last saw. Separate from `cached`: a getDaintreeTheme() call
// between a theme write and the observer callback refreshes the cache, and must
// not make the callback think nothing changed.
let lastNotified: PluginDaintreeTheme | null = null;

function readColorMode(root: HTMLElement): "dark" | "light" {
  const mode = root.dataset.colorMode;
  if (mode === "light" || mode === "dark") return mode;
  return root.classList.contains("light") ? "light" : "dark";
}

// Inline reads only: no style recalc, so a root style write unrelated to the
// theme costs a string compare, not a resolution.
function readSignature(root: HTMLElement): string {
  let signature = `${root.dataset.theme ?? ""}|${readColorMode(root)}|${root.dataset.colorblind ?? ""}`;
  for (const key of THEME_TOKEN_KEYS) {
    signature += `|${root.style.getPropertyValue(`--theme-${key}`)}`;
  }
  return signature;
}

function toHex(channel: number): string {
  return channel.toString(16).padStart(2, "0");
}

function formatRgba(r: number, g: number, b: number, alpha: number): string {
  if (alpha >= 1) return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

const RGB_PATTERN =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/i;

function parseRgb(value: string): string | null {
  const match = RGB_PATTERN.exec(value);
  if (!match) return null;
  const [r, g, b] = [match[1], match[2], match[3]].map((c) => Math.min(255, Math.round(Number(c))));
  let alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (match[5]) alpha /= 100;
  if ([r, g, b, alpha].some((n) => !Number.isFinite(n))) return null;
  return formatRgba(r!, g!, b!, Math.max(0, Math.min(1, alpha)));
}

let canvasContext: CanvasRenderingContext2D | null | undefined;

// Chromium serialises a computed oklch()/color-mix() colour in its own space,
// which WebGL code cannot parse; a 1px canvas round-trip turns it into sRGB.
function rasterise(value: string): string | null {
  if (canvasContext === undefined) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      canvasContext = canvas.getContext("2d", { willReadFrequently: true });
    } catch {
      canvasContext = null;
    }
  }
  const ctx = canvasContext;
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return formatRgba(r!, g!, b!, a! / 255);
  } catch {
    return null;
  }
}

const HEX_PATTERN = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function parseHex(value: string): string | null {
  const match = HEX_PATTERN.exec(value);
  if (!match) return null;
  let digits = match[1]!;
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
  const channels = digits.match(/../g)!.map((pair) => parseInt(pair, 16));
  return formatRgba(channels[0]!, channels[1]!, channels[2]!, (channels[3] ?? 255) / 255);
}

// Hex and rgb() values, which are most of every theme, are normalised
// directly. The rest (oklch(), color-mix(), var()) go through probes appended
// together, so the browser resolves them all in one style pass.
function resolveTokens(root: HTMLElement): PluginThemeTokens {
  const tokens: Record<PluginThemeTokenKey, string> = { ...EMPTY_TOKENS };
  const deferred: PluginThemeTokenKey[] = [];
  for (const key of THEME_TOKEN_KEYS) {
    const raw = root.style.getPropertyValue(`--theme-${key}`).trim();
    const direct = raw ? (parseHex(raw) ?? parseRgb(raw)) : "";
    if (direct === null) deferred.push(key);
    else tokens[key] = direct;
  }
  if (deferred.length === 0) return Object.freeze(tokens);

  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.display = "none";
  const probes = deferred.map((key) => {
    const probe = document.createElement("span");
    probe.style.setProperty("color", `var(--theme-${key})`);
    container.appendChild(probe);
    return probe;
  });
  (document.body ?? root).appendChild(container);
  try {
    deferred.forEach((key, index) => {
      const raw = root.style.getPropertyValue(`--theme-${key}`).trim();
      const computed = getComputedStyle(probes[index]!).color.trim();
      tokens[key] = parseRgb(computed) ?? (computed ? rasterise(computed) : null) ?? raw;
    });
  } finally {
    container.remove();
  }
  return Object.freeze(tokens);
}

function readTheme(): PluginDaintreeTheme {
  const root = document.documentElement;
  const signature = readSignature(root);
  if (cached && signature === cachedSignature) return cached;
  cachedSignature = signature;
  cached = Object.freeze({
    colorMode: readColorMode(root),
    themeId: root.dataset.theme ?? "",
    tokens: resolveTokens(root),
  });
  return cached;
}

function handleMutation(): void {
  const next = readTheme();
  if (next === lastNotified) return;
  lastNotified = next;
  for (const { listener } of [...listeners]) {
    try {
      listener(next);
    } catch (error) {
      // One plugin's throwing listener must not starve the others.
      console.warn("[plugin-ui] onDidChangeDaintreeTheme listener threw", error);
    }
  }
}

/**
 * The active theme. Cheap to call repeatedly: tokens are resolved once per
 * theme change and the same frozen object comes back until the next one.
 */
export function getDaintreeTheme(): PluginDaintreeTheme {
  return readTheme();
}

/** Calls `listener` after every theme change. Returns a function that stops it. */
export function onDidChangeDaintreeTheme(
  listener: (theme: PluginDaintreeTheme) => void
): () => void {
  if (typeof listener !== "function") return () => {};
  const entry = { listener };
  listeners.add(entry);
  if (!observer) {
    lastNotified = readTheme();
    observer = new MutationObserver(handleMutation);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(entry);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

/** The active theme, re-rendering the component when it changes. */
export function useDaintreeTheme(): PluginDaintreeTheme {
  return useSyncExternalStore(onDidChangeDaintreeTheme, getDaintreeTheme);
}
