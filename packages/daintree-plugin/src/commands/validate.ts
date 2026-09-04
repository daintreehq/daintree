import fs from "node:fs/promises";
import path from "node:path";
import { getPluginManifestSchema } from "../../../../electron/schemas/plugin.js";
import { collectManifestAdvisories } from "../../../../electron/schemas/pluginManifestAdvisories.js";
import type { PluginOrigin } from "../../../../shared/types/plugin.js";

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

/**
 * Match `${settings:KEY}` interpolation tokens used in mcpServers env/args. The
 * key grammar mirrors the host's substitution gate exactly — `SETTINGS_TEMPLATE_RE`
 * in `electron/services/PluginMcpSupervisor.ts` only resolves `[a-zA-Z0-9._-]+`,
 * so a token with any other character (e.g. a space) would never be substituted
 * at runtime. Validating with the same grammar means `--env` reports the same
 * set of tokens the host will actually resolve, instead of the broader `[^}]+`
 * that flagged tokens the supervisor silently leaves literal.
 */
const SETTINGS_TOKEN = /\$\{settings:([a-zA-Z0-9._-]+)\}/g;

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

  // The CLI validates a source directory, so there is no discovery root to key
  // the origin off — take the author at their word. A manifest declaring
  // `scope: "project"` is checked under the project origin (which is where it
  // will actually be loaded from); everything else under `"user"`, the origin a
  // packaged .dntr installs into. `"builtin"` is deliberately unreachable: the
  // reserved `daintree.*` namespace stays refused for third-party authors.
  const declaredScope = (json as { scope?: unknown } | null)?.scope;
  const origin: PluginOrigin = declaredScope === "project" ? "project" : "user";
  const result = getPluginManifestSchema(origin).safeParse(json);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      errors.push(`${where}: ${issue.message}`);
    }
    return { ok: false, errors, warnings };
  }

  const manifest = result.data;

  warnings.push(...(await collectManifestAdvisories({ dir, rawJson: json, manifest })));

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
