/**
 * Maps the active Daintree theme onto Mermaid's `base` theme.
 *
 * The theme lives only as custom properties written inline on <html> (see
 * `applyAppThemeToRoot`), and Mermaid derives shades from its inputs with its
 * own color math, so it needs concrete colors rather than `var()` or
 * `color-mix()` expressions. Reading the tokens' computed text is cheap and
 * gives a signature that moves with every theme, accent and color-vision
 * change; resolving them to real colors needs layout and a canvas, so that
 * only happens when a diagram is actually rendered.
 */

const THEME_TOKENS = [
  ["background", "--color-surface-canvas"],
  ["nodeFill", "--color-surface-panel-elevated"],
  ["secondaryFill", "--color-surface-sidebar"],
  ["tertiaryFill", "--color-surface-panel"],
  ["border", "--color-border-strong"],
  ["line", "--color-text-secondary"],
  ["text", "--color-text-primary"],
  ["mutedText", "--color-text-muted"],
] as const;

type ThemeTokenName = (typeof THEME_TOKENS)[number][0];

const BACKGROUND_TOKEN = "--color-surface-canvas";

const FALLBACK_FONT = "system-ui, sans-serif";

export interface MermaidPalette {
  darkMode: boolean;
  fontFamily: string;
  /** The body type-scale rung in px, which Mermaid needs as a length; absent if unresolved. */
  fontSize?: string;
  /** Opaque hex per token; a token that could not be resolved is left out. */
  colors: Partial<Record<ThemeTokenName, string>>;
}

function isDarkRoot(root: HTMLElement): boolean {
  return root.dataset.colorMode
    ? root.dataset.colorMode === "dark"
    : root.classList.contains("dark");
}

/** Cheap fingerprint of every input the palette depends on. */
export function readThemeSignature(root: HTMLElement = document.documentElement): string {
  const computed = getComputedStyle(root);
  const parts: string[] = [isDarkRoot(root) ? "dark" : "light"];
  for (const [, token] of THEME_TOKENS) {
    parts.push(computed.getPropertyValue(token).trim());
  }
  return parts.join("|");
}

let pixelContext: CanvasRenderingContext2D | null | undefined;
const HEX_DIGITS = "0123456789abcdef";

function getPixelContext(): CanvasRenderingContext2D | null {
  if (pixelContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    pixelContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  return pixelContext;
}

function hexByte(value: number): string {
  return HEX_DIGITS[(value >> 4) & 15]! + HEX_DIGITS[value & 15]!;
}

/**
 * Normalises any CSS color the browser understands (oklch, color-mix, …) to
 * an opaque hex Mermaid's color math can work with, by painting it over
 * `backdrop`. A translucent token is what it looks like over that backdrop,
 * which is how the document shows it. Returns null when there is nothing to
 * paint with, so the caller can leave Mermaid's own value in place.
 */
function toOpaqueHex(color: string, backdrop: string): string | null {
  const context = getPixelContext();
  if (!context || !color) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = backdrop;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

function readTokenColor(probe: HTMLElement, token: string): string {
  probe.style.color = "";
  probe.style.color = `var(${token})`;
  return getComputedStyle(probe).color;
}

export function resolveMermaidPalette(
  root: HTMLElement = document.documentElement
): MermaidPalette {
  const darkMode = isDarkRoot(root);
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const colors: Partial<Record<ThemeTokenName, string>> = {};
  let fontSize: string | undefined;
  try {
    probe.style.fontSize = "var(--text-sm)";
    fontSize = getComputedStyle(probe).fontSize || undefined;
    const background =
      toOpaqueHex(readTokenColor(probe, BACKGROUND_TOKEN), darkMode ? "#000" : "#fff") ??
      (darkMode ? "#1e1e1e" : "#ffffff");
    colors.background = background;
    for (const [name, token] of THEME_TOKENS) {
      if (name === "background") continue;
      const resolved = toOpaqueHex(readTokenColor(probe, token), background);
      if (resolved) colors[name] = resolved;
    }
  } finally {
    probe.remove();
  }
  // The UI font, which the document body carries; diagram labels match it.
  const font = getComputedStyle(document.body).fontFamily.trim();
  return { darkMode, fontFamily: font || FALLBACK_FONT, fontSize, colors };
}

/**
 * Mermaid `themeVariables` for the `base` theme. Neutral surfaces only: no
 * accent (diagrams are content, not UI) and no status colors, which would
 * claim a meaning the author never gave a note or a cluster.
 */
export function toMermaidThemeVariables(palette: MermaidPalette): Record<string, string | boolean> {
  const { colors } = palette;
  const variables: Record<string, string | boolean | undefined> = {
    darkMode: palette.darkMode,
    fontFamily: palette.fontFamily,
    fontSize: palette.fontSize,
    background: colors.background,
    mainBkg: colors.nodeFill,
    primaryColor: colors.nodeFill,
    primaryTextColor: colors.text,
    primaryBorderColor: colors.border,
    secondaryColor: colors.secondaryFill,
    secondaryTextColor: colors.text,
    secondaryBorderColor: colors.border,
    tertiaryColor: colors.tertiaryFill,
    tertiaryTextColor: colors.text,
    tertiaryBorderColor: colors.border,
    nodeBorder: colors.border,
    nodeTextColor: colors.text,
    clusterBkg: colors.secondaryFill,
    clusterBorder: colors.border,
    lineColor: colors.line,
    textColor: colors.text,
    titleColor: colors.text,
    edgeLabelBackground: colors.background,
    labelTextColor: colors.text,
    noteBkgColor: colors.tertiaryFill,
    noteTextColor: colors.text,
    noteBorderColor: colors.border,
    actorBkg: colors.nodeFill,
    actorBorder: colors.border,
    actorTextColor: colors.text,
    actorLineColor: colors.line,
    signalColor: colors.line,
    signalTextColor: colors.text,
    labelBoxBkgColor: colors.nodeFill,
    labelBoxBorderColor: colors.border,
    loopTextColor: colors.text,
    activationBkgColor: colors.secondaryFill,
    activationBorderColor: colors.border,
    sequenceNumberColor: colors.background,
    sectionBkgColor: colors.secondaryFill,
    altSectionBkgColor: colors.background,
    taskTextColor: colors.text,
    taskTextOutsideColor: colors.text,
    gridColor: colors.mutedText,
  };
  const defined: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}

let signature: string | null = null;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function refreshSignature(): void {
  const next = readThemeSignature();
  if (next === signature) return;
  signature = next;
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` source for the theme signature. */
export function subscribeThemeSignature(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(refreshSignature);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme", "data-color-mode", "data-colorblind"],
    });
    // Nothing was watching before this point, so a signature read earlier may
    // already be stale; a missed change would otherwise stand until the next.
    if (signature === null) signature = readThemeSignature();
    else refreshSignature();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
      signature = null;
    }
  };
}

export function getThemeSignature(): string {
  if (signature === null || !observer) signature = readThemeSignature();
  return signature;
}

export function _resetMermaidThemeForTests(): void {
  observer?.disconnect();
  observer = null;
  signature = null;
  listeners.clear();
  pixelContext = undefined;
}
