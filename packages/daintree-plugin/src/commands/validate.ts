import fs from "node:fs/promises";
import path from "node:path";
import {
  DEPRECATED_CONTRIBUTION_ALIASES,
  getPluginManifestSchema,
} from "../../../../electron/schemas/plugin.js";
import { PLUGIN_ICON_IDS, isPluginIconId } from "../../../../shared/config/pluginIconIds.js";
import { isBuiltInAgentId } from "../../../../shared/config/agentIds.js";

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

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Advisory existence check for a relative build target (`main`, a view's
 * `componentPath`). Pushes a warning when the file is missing but its top-level
 * directory exists — a stale or mistyped path. Skips absolute paths, Windows
 * separators, and the unbuilt-output case where the top-level dir (e.g. `dist`)
 * is itself absent, so running `validate` before a build stays quiet.
 */
async function warnIfTargetMissing(
  dir: string,
  target: string | undefined,
  label: string,
  warnings: string[]
): Promise<void> {
  if (!target || path.isAbsolute(target) || target.includes("\\")) return;
  if (await pathExists(path.join(dir, target))) return;
  // Normalize a leading `./` so the top-segment check sees `dist`, not `.`
  // (a bare `.` always exists and would defeat the unbuilt-output skip below).
  const normalized = target.replace(/^\.\//, "");
  const [topSegment] = normalized.split("/");
  if (normalized.includes("/") && !(await pathExists(path.join(dir, topSegment)))) return;
  warnings.push(`${label} "${target}" doesn't exist on disk — build the plugin or fix the path`);
}

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
    // `>=0.11.0` (open-ended), not `^0.11.0`: the caret on a 0.x minor resolves
    // to `>=0.11.0 <0.12.0`, which the host's engine gate rejects on every
    // release past 0.11.
    warnings.push("engines.daintree omitted — consider pinning a range, e.g. >=0.11.0");
  }

  for (const [index, command] of manifest.contributes.commands.entries()) {
    if (!command.keywords || command.keywords.length === 0) {
      warnings.push(
        `commands[${index}].keywords is empty — 2–3 terms help discoverability in the palette`
      );
    }
  }

  // Advisory icon check: an `iconId` outside the shared registry renders as a
  // generic fallback glyph (the renderers do no dynamic Lucide-by-name lookup).
  // Non-fatal: the schema accepts any string and the renderer is the runtime
  // authority. Panel surfaces additionally exempt built-in agent ids —
  // `PanelKindIcon` resolves those via `getAgentConfig` to the agent's brand
  // icon before consulting the registry. Toolbar surfaces get no such
  // exemption: they never resolve agent brand icons.
  const knownIds = PLUGIN_ICON_IDS.join(", ");
  const isUnrenderablePanelIcon = (iconId: string): boolean =>
    !isPluginIconId(iconId) && !isBuiltInAgentId(iconId);
  for (const [index, panel] of manifest.contributes.panels.entries()) {
    if (panel.iconId && isUnrenderablePanelIcon(panel.iconId)) {
      warnings.push(
        `panels[${index}].iconId "${panel.iconId}" isn't a recognized panel icon — it will render as the default terminal icon. Known ids: ${knownIds}`
      );
    }
  }
  for (const [index, view] of manifest.contributes.views.entries()) {
    if (view.iconId && isUnrenderablePanelIcon(view.iconId)) {
      warnings.push(
        `views[${index}].iconId "${view.iconId}" isn't a recognized panel icon. This field is ignored at runtime — set iconId on the matching panels entry instead. Known ids: ${knownIds}`
      );
    }
  }
  for (const [index, button] of manifest.contributes.toolbarButtons.entries()) {
    if (button.iconId && !isPluginIconId(button.iconId)) {
      warnings.push(
        `toolbarButtons[${index}].iconId "${button.iconId}" isn't a recognized plugin icon — it will render as the default package icon. Known ids: ${knownIds}`
      );
    }
  }

  // Advisory build-target check: warn when `main` or a view's `componentPath`
  // points at a missing file whose parent dir exists (a typo or stale path). A
  // missing top-level dir — typically an unbuilt `dist/` — is skipped so
  // pre-build validation stays quiet.
  await warnIfTargetMissing(dir, manifest.main, "main", warnings);
  for (const [index, view] of manifest.contributes.views.entries()) {
    await warnIfTargetMissing(dir, view.componentPath, `views[${index}].componentPath`, warnings);
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
