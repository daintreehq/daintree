import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  APP_THEME_TOKEN_KEYS,
  LEGACY_THEME_TOKEN_ALIASES,
  getAppThemeWarnings,
  getBuiltInAppSchemeForType,
  inferAppThemeTypeFromTokens,
  normalizeAppColorScheme,
  type AppThemeImportResult,
} from "../../shared/theme/index.js";

const THEME_SCHEMA = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.enum(["dark", "light"]).optional(),
    tokens: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const KNOWN_TOKEN_KEYS = new Set<string>([
  ...APP_THEME_TOKEN_KEYS,
  ...Object.keys(LEGACY_THEME_TOKEN_ALIASES),
]);

const METADATA_KEYS = new Set([
  "id",
  "name",
  "type",
  "author",
  "version",
  "engine",
  "previewColors",
  "location",
  "heroImage",
  "heroVideo",
]);

function generateThemeId(name: string): string {
  return `custom-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function getFileDisplayName(filename: string): string {
  const baseName = path.basename(filename, path.extname(filename));
  return baseName.trim() || "Imported Theme";
}

function collectFlatThemeTokens(rawData: Record<string, unknown>): Record<string, unknown> {
  const tokens: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawData)) {
    if (METADATA_KEYS.has(key)) {
      continue;
    }
    if (KNOWN_TOKEN_KEYS.has(key)) {
      tokens[key] = value;
    }
  }

  return tokens;
}

export function parseAppThemeContent(content: string, filename: string): AppThemeImportResult {
  let rawData: unknown;

  try {
    rawData = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      errors: [
        error instanceof Error
          ? `Failed to parse app theme JSON: ${error.message}`
          : "Failed to parse app theme JSON",
      ],
    };
  }

  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    return {
      ok: false,
      errors: ["App theme file must contain a JSON object"],
    };
  }

  const parsed = THEME_SCHEMA.safeParse(rawData);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => issue.message),
    };
  }

  const rawTheme = parsed.data;
  const usedNestedTokens = !!rawTheme.tokens;
  const rawTokens = usedNestedTokens
    ? (rawTheme.tokens as Record<string, unknown>)
    : collectFlatThemeTokens(rawTheme as Record<string, unknown>);

  const recognizedTokenCount = Object.keys(rawTokens).filter((key) =>
    KNOWN_TOKEN_KEYS.has(key)
  ).length;
  if (recognizedTokenCount === 0) {
    return {
      ok: false,
      errors: ["No recognized app theme tokens found"],
    };
  }

  const resolvedType = rawTheme.type ?? inferAppThemeTypeFromTokens(rawTokens) ?? "dark";
  const name = rawTheme.name?.trim() || getFileDisplayName(filename);
  const rawRecord = rawTheme as Record<string, unknown>;
  const scheme = normalizeAppColorScheme(
    {
      id: rawTheme.id?.trim() || generateThemeId(name),
      name,
      type: resolvedType,
      tokens: rawTokens,
      ...(typeof rawRecord.location === "string" ? { location: rawRecord.location } : {}),
      ...(typeof rawRecord.heroImage === "string" ? { heroImage: rawRecord.heroImage } : {}),
      ...(typeof rawRecord.heroVideo === "string" ? { heroVideo: rawRecord.heroVideo } : {}),
    },
    getBuiltInAppSchemeForType(resolvedType)
  );

  const warnings = [];

  if (!rawTheme.type) {
    warnings.push({
      message: `Theme type was inferred as ${resolvedType}. Add "type" to make the file explicit.`,
    });
  }

  if (usedNestedTokens) {
    const unknownTokens = Object.keys(rawTokens)
      .filter((key) => !KNOWN_TOKEN_KEYS.has(key))
      .sort();
    if (unknownTokens.length > 0) {
      warnings.push({
        message: `Ignored unknown tokens: ${unknownTokens.join(", ")}`,
      });
    }
  }

  warnings.push(...getAppThemeWarnings(scheme));

  return {
    ok: true,
    scheme,
    warnings,
  };
}

export async function parseAppThemeFile(filePath: string): Promise<AppThemeImportResult> {
  try {
    const content = await readFile(filePath, "utf8");
    return parseAppThemeContent(content, path.basename(filePath));
  } catch (error) {
    return {
      ok: false,
      errors: [
        error instanceof Error
          ? `Failed to read app theme file: ${error.message}`
          : "Failed to read app theme file",
      ],
    };
  }
}
