import { z } from "zod";
import { isValidCssColor, validateImportedThemeData } from "./colorValidator.js";
import { isCssDeclarationValue, isExtensionKey } from "./extensionKeys.js";
import {
  getAppThemeWarnings,
  getBuiltInAppSchemeForType,
  normalizeAppColorScheme,
} from "./themes.js";
import {
  APP_THEME_TOKEN_KEYS,
  type AppColorScheme,
  type ExtensionKey,
  type PluginThemeSnapshot,
  type PluginThemeSource,
} from "./types.js";
import type { ThemePalette } from "./palette.js";

/**
 * Themes an installed plugin contributes (#13832). Each one is a palette plus
 * token and extension overrides limited to the registered sets, compiled the
 * way the built-ins are and held to their contrast bar: a theme that fails it
 * is never offered.
 *
 * Ids live in a namespace nothing else can produce. The importer and the
 * custom-scheme writer refuse the prefix, and resolution tries built-ins, then
 * imported themes, then plugin themes, so a plugin theme can never shadow
 * either of the others.
 */
export const PLUGIN_THEME_ID_PREFIX = "plugin:";

export function makePluginThemeId(pluginId: string, themeId: string): string {
  return `${PLUGIN_THEME_ID_PREFIX}${pluginId}:${themeId}`;
}

/** Neither a plugin id nor a contribution id can hold a `:`, so exactly two parts follow the prefix. */
export function parsePluginThemeId(id: string): { pluginId: string; themeId: string } | null {
  if (!id.startsWith(PLUGIN_THEME_ID_PREFIX)) return null;
  const parts = id.slice(PLUGIN_THEME_ID_PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { pluginId: parts[0], themeId: parts[1] };
}

/** Whether `id` sits in the reserved namespace, well formed or not. */
export function isPluginThemeId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(PLUGIN_THEME_ID_PREFIX);
}

const cssColor = z
  .string()
  .refine((value) => isValidCssColor(value) && isCssDeclarationValue(value), {
    message: "must be a CSS color",
  });

const strategySchema = z.strictObject({
  shadowStyle: z.enum(["none", "crisp", "soft", "atmospheric", "light"]).optional(),
  noiseOpacity: z.number().min(0).max(1).optional(),
  materialBlur: z.number().min(0).max(64).optional(),
  materialSaturation: z.number().min(0).max(400).optional(),
  radiusScale: z.number().min(0).max(4).optional(),
  panelStateEdge: z.boolean().optional(),
  borderInkOverride: cssColor.optional(),
  statusSurfaceOpacity: z.number().min(0).max(4).optional(),
  grainCharacter: z.enum(["fine", "coarse", "paper", "none"]).optional(),
});

const paletteSchema = z.strictObject({
  type: z.enum(["dark", "light"]),
  surfaces: z.strictObject({
    grid: cssColor,
    sidebar: cssColor,
    canvas: cssColor,
    panel: cssColor,
    elevated: cssColor,
  }),
  text: z.strictObject({
    primary: cssColor,
    secondary: cssColor,
    muted: cssColor,
    inverse: cssColor,
  }),
  border: cssColor,
  accent: cssColor,
  accentSecondary: cssColor.optional(),
  status: z.strictObject({
    success: cssColor,
    warning: cssColor,
    danger: cssColor,
    info: cssColor,
  }),
  activity: z.strictObject({
    active: cssColor,
    idle: cssColor,
    working: cssColor,
    waiting: cssColor,
  }),
  overlayTint: cssColor.optional(),
  terminal: z
    .strictObject({
      background: cssColor.optional(),
      foreground: cssColor.optional(),
      muted: cssColor.optional(),
      cursor: cssColor.optional(),
      selection: cssColor,
      red: cssColor,
      green: cssColor,
      yellow: cssColor,
      blue: cssColor,
      magenta: cssColor,
      cyan: cssColor,
      brightRed: cssColor,
      brightGreen: cssColor,
      brightYellow: cssColor,
      brightBlue: cssColor,
      brightMagenta: cssColor,
      brightCyan: cssColor,
      brightWhite: cssColor,
    })
    .optional(),
  syntax: z.strictObject({
    comment: cssColor,
    punctuation: cssColor,
    number: cssColor,
    string: cssColor,
    operator: cssColor,
    keyword: cssColor,
    function: cssColor,
    link: cssColor,
    quote: cssColor,
    chip: cssColor,
  }),
  strategy: strategySchema.optional(),
});

const themeFileSchema = z.strictObject({
  palette: paletteSchema,
  tokens: z.record(z.string(), z.string()).optional(),
  extensions: z.record(z.string(), z.string()).optional(),
});

const TOKEN_KEY_SET: ReadonlySet<string> = new Set<string>(APP_THEME_TOKEN_KEYS);

export interface PluginThemeFile {
  palette: ThemePalette;
  tokens?: Record<string, string>;
  extensions?: Partial<Record<ExtensionKey, string>>;
}

export type PluginThemeFileResult =
  { ok: true; file: PluginThemeFile } | { ok: false; errors: string[] };

function ownKeys(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

/**
 * Validate a plugin theme file's contents against the polarity its manifest
 * entry declares. Strict throughout: a missing palette field, an unknown key,
 * a token or extension outside the registered sets, or a value that is not a
 * single CSS value is an error, never silently dropped — the author has no
 * other way to learn their theme is not what they wrote.
 */
export function parsePluginThemeFile(raw: unknown, type: "dark" | "light"): PluginThemeFileResult {
  const parsed = themeFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message
      ),
    };
  }
  const errors: string[] = [];
  const { palette, tokens, extensions } = parsed.data;
  if (palette.type !== type) {
    errors.push(`palette.type is "${palette.type}" but the manifest declares "${type}"`);
  }

  // Keys are read off the raw object: a record parser skips `__proto__`, so
  // the parsed copy would hide it.
  const rawRecord = raw as Record<string, unknown>;
  const unknownTokens = ownKeys(rawRecord.tokens).filter((key) => !TOKEN_KEY_SET.has(key));
  if (unknownTokens.length > 0) {
    errors.push(`Unknown tokens: ${unknownTokens.sort().join(", ")}`);
  }
  if (tokens) {
    const validation = validateImportedThemeData({ tokens });
    if (!validation.valid) errors.push(...validation.errors);
    const unsafe = Object.entries(tokens)
      .filter(([, value]) => !isCssDeclarationValue(value))
      .map(([key]) => key);
    if (unsafe.length > 0) {
      errors.push(`Tokens whose value is not a single CSS value: ${unsafe.sort().join(", ")}`);
    }
  }

  const unknownExtensions = ownKeys(rawRecord.extensions).filter((key) => !isExtensionKey(key));
  if (unknownExtensions.length > 0) {
    errors.push(`Unknown extensions: ${unknownExtensions.sort().join(", ")}`);
  }
  if (extensions) {
    const unsafe = Object.entries(extensions)
      .filter(([, value]) => !isCssDeclarationValue(value))
      .map(([key]) => key);
    if (unsafe.length > 0) {
      errors.push(`Extensions whose value is not a single CSS value: ${unsafe.sort().join(", ")}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    file: {
      palette: palette as ThemePalette,
      ...(tokens ? { tokens } : {}),
      ...(extensions ? { extensions: extensions as Partial<Record<ExtensionKey, string>> } : {}),
    },
  };
}

/** The full scheme for a plugin theme, compiled through the same path as an imported one. */
export function compilePluginTheme(source: PluginThemeSource): AppColorScheme {
  const scheme = normalizeAppColorScheme(
    {
      id: source.id,
      name: source.name,
      type: source.type,
      palette: source.palette,
      ...(source.tokens ? { tokens: source.tokens } : {}),
      ...(source.extensions ? { extensions: source.extensions } : {}),
    },
    getBuiltInAppSchemeForType(source.type)
  );
  return { ...scheme, plugin: { id: source.pluginId, name: source.pluginName } };
}

/**
 * Every check an imported theme is warned about, as failures. For a plugin
 * theme they are a gate rather than advice: the user didn't author it, so a
 * warning they never see would protect no one. Empty means it may be offered.
 */
export function getPluginThemeGateFailures(scheme: AppColorScheme): string[] {
  return getAppThemeWarnings(scheme).map((warning) => warning.message);
}

export function toPluginThemeSnapshot(source: PluginThemeSource): PluginThemeSnapshot {
  return {
    version: 1,
    id: source.id,
    name: source.name,
    type: source.type,
    pluginId: source.pluginId,
    pluginName: source.pluginName,
    palette: source.palette,
    ...(source.tokens ? { tokens: source.tokens } : {}),
    ...(source.extensions ? { extensions: source.extensions } : {}),
  };
}

/**
 * `schemes` plus the persisted plugin theme when it is the selection and not
 * already among them — what a path that runs before plugins load resolves the
 * selected id against.
 */
export function withSelectedPluginTheme(
  schemes: readonly AppColorScheme[],
  themeConfig: unknown
): AppColorScheme[] {
  const selected = readPluginThemeSnapshot(themeConfig);
  if (!selected || schemes.some((scheme) => scheme.id === selected.id)) return [...schemes];
  return [...schemes, selected];
}

/**
 * The persisted plugin theme for `themeConfig`'s selection, or null. The
 * store is plain JSON on disk, so the snapshot is validated again on every
 * read; one that names anything but the selected id is stale and ignored.
 */
export function readPluginThemeSnapshot(themeConfig: unknown): AppColorScheme | null {
  if (themeConfig === null || typeof themeConfig !== "object") return null;
  const { colorSchemeId, pluginThemeSnapshot: snapshot } = themeConfig as Record<string, unknown>;
  if (snapshot === null || typeof snapshot !== "object") return null;
  const record = snapshot as Record<string, unknown>;
  if (record.version !== 1) return null;
  const { id, name, type, pluginId, pluginName } = record;
  if (typeof id !== "string" || typeof colorSchemeId !== "string" || id !== colorSchemeId.trim()) {
    return null;
  }
  const parsedId = parsePluginThemeId(id);
  if (!parsedId || parsedId.pluginId !== pluginId) return null;
  if (typeof name !== "string" || !name.trim()) return null;
  if (typeof pluginName !== "string" || !pluginName.trim()) return null;
  if (type !== "dark" && type !== "light") return null;
  try {
    const file = parsePluginThemeFile(
      {
        palette: record.palette,
        ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
        ...(record.extensions !== undefined ? { extensions: record.extensions } : {}),
      },
      type
    );
    if (!file.ok) return null;
    return compilePluginTheme({
      id,
      name,
      type,
      pluginId: parsedId.pluginId,
      pluginName,
      ...file.file,
    });
  } catch {
    return null;
  }
}
