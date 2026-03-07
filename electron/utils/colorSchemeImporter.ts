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
  background: "#19191a",
  foreground: "#e4e4e7",
  cursor: "#3F9366",
  cursorAccent: "#19191a",
  selectionBackground: "#1a2c22",
  selectionForeground: "#e4e4e7",
  black: "#19191a",
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

function parseItermColors(content: string, filename: string): ImportResult {
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
    // Support both <real> (float 0.0-1.0) and <integer> (0 or 1) component formats
    const compPattern =
      /<key>(Red|Green|Blue) Component<\/key>\s*<(?:real|integer)>([\d.eE+-]+)<\/(?:real|integer)>/gi;
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
  // Derive name from filename (strip extension), fall back to generic name
  const baseName = path.basename(filename, path.extname(filename));
  const name = baseName.length > 0 && baseName !== filename ? baseName : "Imported iTerm Theme";
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
// Mapping follows the base16-shell convention:
// https://github.com/chriskempson/base16-shell/blob/master/templates/default.mustache
// ANSI 0=base00(bg), 1=base08(red), 2=base0B(green), 3=base0A(yellow),
//      4=base0D(blue), 5=base0E(magenta), 6=base0C(cyan), 7=base05(fg-normal),
//      8=base03(comment), 9=base09(orange→brightRed), 10=base01(dark),
//      11=base02(selection), 12=base04(dark-fg), 13=base06(light),
//      14=base0F(deprecated/brown), 15=base07(light-bg)
const BASE16_MAP: Record<string, keyof ImportedSchemeColors> = {
  BASE00: "black",
  BASE01: "brightBlack",
  BASE02: "selectionBackground",
  BASE03: "brightBlack",
  BASE04: "selectionForeground",
  BASE05: "foreground",
  BASE06: "white",
  BASE07: "brightWhite",
  BASE08: "red",
  BASE09: "brightRed",
  BASE0A: "yellow",
  BASE0B: "green",
  BASE0C: "cyan",
  BASE0D: "blue",
  BASE0E: "magenta",
  BASE0F: "brightYellow",
};

function toBase16Key(k: string): string {
  return k.toUpperCase();
}

function parseBase16Json(data: Record<string, unknown>): ImportResult {
  const colors: ImportedSchemeColors = {};

  // Normalize all keys to uppercase for case-insensitive matching
  const normalizedData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    normalizedData[toBase16Key(k)] = v;
  }

  // Derive background from base00
  const bg = normalizedData["BASE00"];
  if (typeof bg === "string") {
    colors.background = bg.startsWith("#") ? bg : `#${bg}`;
    colors.black = colors.background;
    colors.cursorAccent = colors.background;
  }

  for (const [b16Key, schemeKey] of Object.entries(BASE16_MAP)) {
    const value = normalizedData[b16Key];
    if (typeof value === "string") {
      const hex = value.startsWith("#") ? value : `#${value}`;
      colors[schemeKey] = hex;
    }
  }

  if (!colors.cursor && colors.foreground) colors.cursor = colors.foreground;
  // Fill missing bright variants from their normal counterparts
  if (colors.red && !colors.brightRed) colors.brightRed = colors.red;
  if (colors.green && !colors.brightGreen) colors.brightGreen = colors.green;
  if (colors.blue && !colors.brightBlue) colors.brightBlue = colors.blue;
  if (colors.magenta && !colors.brightMagenta) colors.brightMagenta = colors.magenta;
  if (colors.cyan && !colors.brightCyan) colors.brightCyan = colors.cyan;

  if (Object.keys(colors).length === 0) {
    return { ok: false, errors: ["No valid base16 color keys found"] };
  }

  const filled = fillDefaults(colors);
  const name =
    typeof data.scheme === "string" && data.scheme ? data.scheme : "Imported Base16 Theme";
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
    return parseItermColors(content, filename);
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
