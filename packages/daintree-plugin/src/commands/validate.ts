import fs from "node:fs/promises";
import path from "node:path";
import {
  DEPRECATED_CONTRIBUTION_ALIASES,
  getPluginManifestSchema,
} from "../../../../electron/schemas/plugin.js";

export interface ValidateOptions {
  /** Plugin project directory (default: cwd). */
  dir?: string;
  /** Resolve `${settings:KEY}` tokens against `.daintree-plugin-env`. */
  env?: boolean;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Match `${settings:KEY}` interpolation tokens used in mcpServers env/args. */
const SETTINGS_TOKEN = /\$\{settings:([^}]+)\}/g;

function parseEnvFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) map.set(key, value);
  }
  return map;
}

/**
 * Validate `plugin.json` against the same Zod schema Daintree uses at load.
 * Returns structured errors and advisory warnings; the CLI layer prints and
 * sets the exit code. With `env`, also checks that every `${settings:KEY}`
 * token in the manifest resolves against `.daintree-plugin-env`.
 */
export async function runValidate(opts: ValidateOptions = {}): Promise<ValidateResult> {
  const dir = opts.dir ?? process.cwd();
  const errors: string[] = [];
  const warnings: string[] = [];

  const manifestPath = path.join(dir, "plugin.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return { ok: false, errors: [`Couldn't read plugin.json at ${manifestPath}`], warnings };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["plugin.json is not valid JSON"], warnings };
  }

  const result = getPluginManifestSchema(false).safeParse(json);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      errors.push(`${where}: ${issue.message}`);
    }
    return { ok: false, errors, warnings };
  }

  const manifest = result.data;

  // Surface deprecated `contributes.experimental_*` aliases here too — the Zod
  // schema migrates them silently, so without this the author gets no feedback
  // until the host logs a deprecation warning at load time.
  const rawContributes = (json as { contributes?: Record<string, unknown> } | null)?.contributes;
  if (rawContributes && typeof rawContributes === "object") {
    for (const [deprecated, canonical] of Object.entries(DEPRECATED_CONTRIBUTION_ALIASES)) {
      if (deprecated in rawContributes) {
        warnings.push(
          `contributes.${deprecated} is deprecated — rename it to contributes.${canonical}`
        );
      }
    }
  }

  if (!manifest.engines?.daintree) {
    warnings.push("engines.daintree omitted — consider pinning a range, e.g. ^0.11.0");
  }

  for (const [index, command] of manifest.contributes.commands.entries()) {
    if (!command.keywords || command.keywords.length === 0) {
      warnings.push(
        `commands[${index}].keywords is empty — 2–3 terms help discoverability in the palette`
      );
    }
  }

  if (opts.env) {
    const envPath = path.join(dir, ".daintree-plugin-env");
    let envMap = new Map<string, string>();
    let envExists = true;
    try {
      envMap = parseEnvFile(await fs.readFile(envPath, "utf8"));
    } catch {
      envExists = false;
    }

    const referenced = new Set<string>();
    for (const match of raw.matchAll(SETTINGS_TOKEN)) {
      const key = match[1]?.trim();
      if (key) referenced.add(key);
    }

    if (referenced.size === 0) {
      warnings.push("--env passed but no ${settings:…} tokens were found in plugin.json");
    } else if (!envExists) {
      errors.push(
        `--env passed but ${envPath} is missing; can't resolve: ${[...referenced].join(", ")}`
      );
    } else {
      for (const key of referenced) {
        if (!envMap.has(key)) {
          errors.push(`\${settings:${key}} has no value in .daintree-plugin-env`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
