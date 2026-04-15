import { z } from "zod";

const SCHEMA_VERSION = 1;
const MAX_FILE_SIZE_BYTES = 100 * 1024;

const profileSchema = z.object({
  schemaVersion: z.number(),
  exportedAt: z.string(),
  app: z.string(),
  overrides: z.record(z.string(), z.array(z.string())),
});

export interface ImportResult {
  ok: boolean;
  overrides: Record<string, string[]>;
  applied: number;
  skipped: number;
  errors: string[];
}

export function exportProfile(overrides: Record<string, string[]>): string {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      app: "daintree",
      overrides,
    },
    null,
    2
  );
}

export function importProfile(json: string): ImportResult {
  if (json.length > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      overrides: {},
      applied: 0,
      skipped: 0,
      errors: ["File too large (max 100KB)"],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      overrides: {},
      applied: 0,
      skipped: 0,
      errors: ["Invalid JSON"],
    };
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "schemaVersion" in parsed &&
    (parsed as Record<string, unknown>).schemaVersion !== SCHEMA_VERSION
  ) {
    return {
      ok: false,
      overrides: {},
      applied: 0,
      skipped: 0,
      errors: [`Unsupported schema version: ${(parsed as Record<string, unknown>).schemaVersion}`],
    };
  }

  const result = profileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      overrides: {},
      applied: 0,
      skipped: 0,
      errors: result.error.issues.map((i) => i.message),
    };
  }

  const filtered: Record<string, string[]> = {};
  let applied = 0;

  for (const [key, value] of Object.entries(result.data.overrides)) {
    if (key.trim() === "") continue;
    // Strip empty/whitespace combo strings, consistent with setOverride validation
    filtered[key] = value.filter((c) => c.trim() !== "");
    applied++;
  }

  return { ok: true, overrides: filtered, applied, skipped: 0, errors: [] };
}
