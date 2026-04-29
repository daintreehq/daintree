/**
 * Zod schemas for custom color schemes (app theme + terminal config).
 * Permissive on read (accepts legacy string, tolerates invalid entries), strict on write.
 */

import { z } from "zod";
const appColorSchemeTokenSchema = z.record(z.string(), z.string());

const themeStrategySchema = z.object({
  shadowStyle: z.enum(["none", "crisp", "soft", "atmospheric"]).optional(),
  noiseOpacity: z.number().optional(),
  materialBlur: z.number().optional(),
  materialSaturation: z.number().optional(),
  radiusScale: z.number().optional(),
  panelStateEdge: z.boolean().optional(),
});

const themePaletteSchema = z.object({
  type: z.enum(["dark", "light"]),
  surfaces: z.object({
    grid: z.string(),
    sidebar: z.string(),
    canvas: z.string(),
    panel: z.string(),
    elevated: z.string(),
  }),
  text: z.object({
    primary: z.string(),
    secondary: z.string(),
    muted: z.string(),
    inverse: z.string(),
  }),
  border: z.string(),
  accent: z.string(),
  accentSecondary: z.string().optional(),
  status: z.object({
    success: z.string(),
    warning: z.string(),
    danger: z.string(),
    info: z.string(),
  }),
  activity: z.object({
    active: z.string(),
    idle: z.string(),
    working: z.string(),
    waiting: z.string(),
  }),
  overlayTint: z.string().optional(),
  terminal: z
    .object({
      background: z.string().optional(),
      foreground: z.string().optional(),
      muted: z.string().optional(),
      cursor: z.string().optional(),
      selection: z.string(),
      red: z.string(),
      green: z.string(),
      yellow: z.string(),
      blue: z.string(),
      magenta: z.string(),
      cyan: z.string(),
      brightRed: z.string(),
      brightGreen: z.string(),
      brightYellow: z.string(),
      brightBlue: z.string(),
      brightMagenta: z.string(),
      brightCyan: z.string(),
      brightWhite: z.string(),
    })
    .optional(),
  syntax: z.object({
    comment: z.string(),
    punctuation: z.string(),
    number: z.string(),
    string: z.string(),
    operator: z.string(),
    keyword: z.string(),
    function: z.string(),
    link: z.string(),
    quote: z.string(),
    chip: z.string(),
  }),
  strategy: themeStrategySchema.optional(),
});

export const appColorSchemeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["dark", "light"]),
  builtin: z.boolean(),
  tokens: appColorSchemeTokenSchema,
  palette: themePaletteSchema.optional(),
  extensions: z.record(z.string(), z.string()).optional(),
  location: z.string().optional(),
  heroImage: z.string().optional(),
  heroVideo: z.string().optional(),
});

/**
 * Read schema: accepts native array OR legacy JSON-encoded string.
 * Uses z.unknown() elements so a single corrupt entry doesn't drop them all —
 * per-entry validation happens in migrateCustomSchemes().
 */
export const appCustomSchemesReadSchema = z.union([
  z.array(z.unknown()),
  z.string().transform((str, ctx) => {
    if (!str.trim()) return [];
    try {
      const parsed = JSON.parse(str);
      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected array" });
        return z.NEVER;
      }
      return parsed;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid JSON" });
      return z.NEVER;
    }
  }),
]);

export const appCustomSchemesWriteSchema = z.array(appColorSchemeSchema);

const terminalColorSchemeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["dark", "light"]),
  builtin: z.boolean(),
  colors: z.record(z.string(), z.string()),
  location: z.string().optional(),
});

export const terminalCustomSchemesReadSchema = z.union([
  z.array(z.unknown()),
  z.string().transform((str, ctx) => {
    if (!str.trim()) return [];
    try {
      const parsed = JSON.parse(str);
      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected array" });
        return z.NEVER;
      }
      return parsed;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid JSON" });
      return z.NEVER;
    }
  }),
]);

export const terminalCustomSchemesWriteSchema = z.array(terminalColorSchemeSchema);

export interface CustomSchemesMigrationResult<T> {
  schemes: T[];
  /** Entries that failed validation and were dropped */
  droppedCount: number;
  /** Human-readable parse/validation errors */
  errors: string[];
  /** Whether the store value was rewritten (migrated or pruned) */
  migrated: boolean;
}

/**
 * Parses a legacy string or native array into a validated scheme array.
 * Returns successfully parsed schemes plus diagnostics for failures.
 */
export function migrateCustomSchemes<T>(
  raw: unknown,
  readSchema: z.ZodSchema<T[]>,
  writeSchema: z.ZodArray<z.ZodSchema<T>>
): CustomSchemesMigrationResult<T> {
  const errors: string[] = [];

  // Step 1: coerce legacy string to unknown array
  const readResult = readSchema.safeParse(raw);
  if (!readResult.success) {
    // If the raw value was a broken legacy string, flag as migrated so the
    // caller rewrites the store to [] instead of re-parsing on every read.
    const cleanupNeeded = typeof raw === "string";
    return {
      schemes: [],
      droppedCount: 0,
      errors: [readResult.error.message],
      migrated: cleanupNeeded,
    };
  }

  const candidates: unknown[] = readResult.data as unknown[];
  const valid: T[] = [];
  let droppedCount = 0;

  // Step 2: validate each entry with strict schema
  for (let i = 0; i < candidates.length; i++) {
    const result = writeSchema.element.safeParse(candidates[i]);
    if (result.success) {
      valid.push(result.data);
    } else {
      droppedCount++;
      const id =
        typeof (candidates[i] as Record<string, unknown>)?.id === "string"
          ? (candidates[i] as Record<string, unknown>).id
          : `index-${i}`;
      errors.push(`Dropped invalid custom scheme "${id}": ${result.error.message}`);
      console.warn(`[customSchemes] ${errors[errors.length - 1]}`);
    }
  }

  // Migration happened if we parsed a string or pruned invalid entries
  const migrated = typeof raw === "string" || droppedCount > 0;

  return { schemes: valid, droppedCount, errors, migrated };
}
