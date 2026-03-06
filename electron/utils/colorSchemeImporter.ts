import { readFile } from "fs/promises";
import path from "path";

interface ImportedSchemeColors {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface ImportedScheme {
  id: string;
  name: string;
  type: "dark" | "light";
  colors: ImportedSchemeColors;
}

export type ImportResult = { ok: true; scheme: ImportedScheme } | { ok: false; errors: string[] };

const CANOPY_DEFAULTS: Required<ImportedSchemeColors> = {
  background: "#18181b",
  foreground: "#e4e4e7",
  cursor: "#10b981",
  cursorAccent: "#18181b",
  selectionBackground: "#064e3b",
  selectionForeground: "#e4e4e7",
  black: "#18181b",
  red: "#f87171",
  green: "#10b981",
  yellow: "#fbbf24",
  blue: "#38bdf8",
  magenta: "#a855f7",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#34d399",
  brightYellow: "#fcd34d",
  brightBlue: "#7dd3fc",
  brightMagenta: "#c084fc",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

function generateSchemeId(name: string): string {
  return `custom-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function isDarkTheme(bg: string): boolean {
  const hex = bg.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

function fillDefaults(colors: ImportedSchemeColors): Required<ImportedSchemeColors> {
  const result = { ...CANOPY_DEFAULTS };
  for (const [key, value] of Object.entries(colors)) {
    if (value && typeof value === "string") {
      (result as Record<string, string>)[key] = value;
    }
  }
  return result;
}

function floatToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// --- iTerm2 .itermcolors parser ---

const ITERM_KEY_MAP: Record<string, keyof ImportedSchemeColors> = {
  "Ansi 0 Color": "black",
  "Ansi 1 Color": "red",
  "Ansi 2 Color": "green",
  "Ansi 3 Color": "yellow",
  "Ansi 4 Color": "blue",
  "Ansi 5 Color": "magenta",
  "Ansi 6 Color": "cyan",
  "Ansi 7 Color": "white",
  "Ansi 8 Color": "brightBlack",
  "Ansi 9 Color": "brightRed",
  "Ansi 10 Color": "brightGreen",
  "Ansi 11 Color": "brightYellow",
  "Ansi 12 Color": "brightBlue",
  "Ansi 13 Color": "brightMagenta",
  "Ansi 14 Color": "brightCyan",
  "Ansi 15 Color": "brightWhite",
  "Background Color": "background",
  "Foreground Color": "foreground",
  "Cursor Color": "cursor",
  "Cursor Text Color": "cursorAccent",
  "Selection Color": "selectionBackground",
  "Selected Text Color": "selectionForeground",
};

function parseItermColors(content: string): ImportResult {
  const colors: ImportedSchemeColors = {};

  for (const [itermKey, schemeKey] of Object.entries(ITERM_KEY_MAP)) {
    const keyPattern = new RegExp(
      `<key>${escapeRegex(itermKey)}</key>\\s*<dict>([\\s\\S]*?)</dict>`,
      "i"
    );
    const dictMatch = content.match(keyPattern);
    if (!dictMatch) continue;

    const dictContent = dictMatch[1];
    const components: Record<string, number> = {};
    const compPattern = /<key>(Red|Green|Blue) Component<\/key>\s*<real>([\d.eE+-]+)<\/real>/gi;
    let compMatch;
    while ((compMatch = compPattern.exec(dictContent)) !== null) {
      components[compMatch[1].toLowerCase()] = parseFloat(compMatch[2]);
    }

    if ("red" in components && "green" in components && "blue" in components) {
      colors[schemeKey] = floatToHex(components.red, components.green, components.blue);
    }
  }

  if (Object.keys(colors).length === 0) {
    return { ok: false, errors: ["No valid color entries found in .itermcolors file"] };
  }

  const filled = fillDefaults(colors);
  const name = "Imported iTerm Theme";
  return {
    ok: true,
    scheme: {
      id: generateSchemeId(name),
      name,
      type: isDarkTheme(filled.background) ? "dark" : "light",
      colors: filled,
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Base16 JSON parser ---

const BASE16_MAP: Record<string, keyof ImportedSchemeColors> = {
  base00: "background",
  base01: "selectionBackground",
  base02: "brightBlack",
  base03: "brightBlack",
  base04: "selectionForeground",
  base05: "foreground",
  base06: "white",
  base07: "brightWhite",
  base08: "red",
  base09: "brightRed",
  base0A: "yellow",
  base0B: "green",
  base0C: "cyan",
  base0D: "blue",
  base0E: "magenta",
  base0F: "brightYellow",
};

function parseBase16Json(data: Record<string, unknown>): ImportResult {
  const colors: ImportedSchemeColors = {};

  for (const [b16Key, schemeKey] of Object.entries(BASE16_MAP)) {
    const value = data[b16Key];
    if (typeof value === "string") {
      colors[schemeKey] = value.startsWith("#") ? value : `#${value}`;
    }
  }

  // Fill bright variants from base colors where not set
  if (colors.red && !colors.brightRed) colors.brightRed = colors.red;
  if (colors.green && !colors.brightGreen) colors.brightGreen = colors.green;
  if (colors.blue && !colors.brightBlue) colors.brightBlue = colors.blue;
  if (colors.magenta && !colors.brightMagenta) colors.brightMagenta = colors.magenta;
  if (colors.cyan && !colors.brightCyan) colors.brightCyan = colors.cyan;
  if (!colors.cursor && colors.foreground) colors.cursor = colors.foreground;
  if (!colors.cursorAccent && colors.background) colors.cursorAccent = colors.background;
  if (!colors.black && colors.background) colors.black = colors.background;

  if (Object.keys(colors).length === 0) {
    return { ok: false, errors: ["No valid base16 color keys found"] };
  }

  const filled = fillDefaults(colors);
  const name = typeof data.scheme === "string" ? data.scheme : "Imported Base16 Theme";
  return {
    ok: true,
    scheme: {
      id: generateSchemeId(name),
      name,
      type: isDarkTheme(filled.background) ? "dark" : "light",
      colors: filled,
    },
  };
}

// --- VS Code JSON parser ---

const VSCODE_MAP: Record<string, keyof ImportedSchemeColors> = {
  "terminal.background": "background",
  "terminal.foreground": "foreground",
  "terminalCursor.foreground": "cursor",
  "terminalCursor.background": "cursorAccent",
  "terminal.selectionBackground": "selectionBackground",
  "terminal.selectionForeground": "selectionForeground",
  "terminal.ansiBlack": "black",
  "terminal.ansiRed": "red",
  "terminal.ansiGreen": "green",
  "terminal.ansiYellow": "yellow",
  "terminal.ansiBlue": "blue",
  "terminal.ansiMagenta": "magenta",
  "terminal.ansiCyan": "cyan",
  "terminal.ansiWhite": "white",
  "terminal.ansiBrightBlack": "brightBlack",
  "terminal.ansiBrightRed": "brightRed",
  "terminal.ansiBrightGreen": "brightGreen",
  "terminal.ansiBrightYellow": "brightYellow",
  "terminal.ansiBrightBlue": "brightBlue",
  "terminal.ansiBrightMagenta": "brightMagenta",
  "terminal.ansiBrightCyan": "brightCyan",
  "terminal.ansiBrightWhite": "brightWhite",
};

function parseVscodeJson(data: Record<string, unknown>): ImportResult {
  const colorData =
    data.colors && typeof data.colors === "object"
      ? (data.colors as Record<string, unknown>)
      : data;

  const colors: ImportedSchemeColors = {};

  for (const [vsKey, schemeKey] of Object.entries(VSCODE_MAP)) {
    const value = colorData[vsKey];
    if (typeof value === "string") {
      colors[schemeKey] = value;
    }
  }

  if (Object.keys(colors).length === 0) {
    return { ok: false, errors: ["No valid VS Code terminal color keys found"] };
  }

  const filled = fillDefaults(colors);
  const name = typeof data.name === "string" ? data.name : "Imported VS Code Theme";
  return {
    ok: true,
    scheme: {
      id: generateSchemeId(name),
      name,
      type: isDarkTheme(filled.background) ? "dark" : "light",
      colors: filled,
    },
  };
}

// --- Main dispatcher ---

export function parseColorSchemeContent(content: string, filename: string): ImportResult {
  const ext = path.extname(filename).toLowerCase();

  if (ext === ".itermcolors") {
    return parseItermColors(content);
  }

  // Try JSON-based formats
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content);
  } catch {
    return { ok: false, errors: [`Failed to parse ${filename} as JSON`] };
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, errors: ["File content is not a JSON object"] };
  }

  // Detect format: VS Code has terminal.* keys, Base16 has base00-base0F
  const keys = Object.keys(data);
  const allKeys =
    data.colors && typeof data.colors === "object"
      ? [...keys, ...Object.keys(data.colors as Record<string, unknown>)]
      : keys;

  const hasVscodeKeys = allKeys.some((k) => k.startsWith("terminal."));
  const hasBase16Keys = allKeys.some((k) => /^base0[0-9A-Fa-f]$/.test(k));

  if (hasVscodeKeys) {
    return parseVscodeJson(data);
  }
  if (hasBase16Keys) {
    return parseBase16Json(data);
  }

  return {
    ok: false,
    errors: [
      "Unrecognized color scheme format. Supported: .itermcolors, Base16 JSON, VS Code JSON",
    ],
  };
}

export async function parseColorSchemeFile(filePath: string): Promise<ImportResult> {
  try {
    const content = await readFile(filePath, "utf-8");
    const filename = path.basename(filePath);
    return parseColorSchemeContent(content, filename);
  } catch (err) {
    return {
      ok: false,
      errors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
