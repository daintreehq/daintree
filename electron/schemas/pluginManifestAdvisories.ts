import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { DEPRECATED_CONTRIBUTION_ALIASES, getPluginManifestSchema } from "./plugin.js";
import { PLUGIN_ICON_IDS, isPluginIconId } from "../../shared/config/pluginIconIds.js";
import { isBuiltInAgentId } from "../../shared/config/agentIds.js";

/**
 * Advisory checks that run *after* a manifest has parsed. Everything here is
 * non-fatal by construction: the Zod schema is the authority on whether a
 * plugin loads, and these describe the ways a manifest can be accepted and
 * still not do what its author meant.
 *
 * Shared rather than duplicated because three callers need the identical text —
 * the `daintree-plugin validate` and `doctor` commands, and the in-app
 * `plugin.validate` action an authoring agent calls over MCP. A warning an
 * agent sees from one surface and not another is worse than no warning: it
 * reads as a difference in the contract rather than a difference in the tool.
 */
/** The Zod-validated manifest, inferred from the schema that produced it. */
export type ValidatedPluginManifest = z.infer<ReturnType<typeof getPluginManifestSchema>>;

export interface ManifestAdvisoryInput {
  /** Plugin directory, used to resolve relative build targets. */
  dir: string;
  /** The raw parsed JSON, before Zod normalized deprecated aliases away. */
  rawJson: unknown;
  /** The Zod-validated manifest. */
  manifest: ValidatedPluginManifest;
}

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
 * is itself absent, so validating before a build stays quiet.
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

/**
 * Every advisory a parsed manifest earns, in a stable order: deprecated
 * aliases, engine range, command discoverability, icon ids, then build targets.
 * Order is part of the contract — the CLI prints them in sequence and the
 * fixtures assert on the first one.
 */
export async function collectManifestAdvisories({
  dir,
  rawJson,
  manifest,
}: ManifestAdvisoryInput): Promise<string[]> {
  const warnings: string[] = [];

  // Surface deprecated `contributes.experimental_*` aliases: the Zod schema
  // migrates them silently, so without this the author gets no feedback until
  // the host logs a deprecation warning at load time.
  const rawContributes = (rawJson as { contributes?: Record<string, unknown> } | null)?.contributes;
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
  // A view's `iconId` is ignored at runtime whatever its value — the matching
  // panels entry owns the rendered icon — so warn on its presence rather than
  // only when it's unrecognized. A recognized-but-ignored id is the more
  // misleading case: it looks like it works.
  for (const [index, view] of manifest.contributes.views.entries()) {
    if (view.iconId) {
      warnings.push(
        `views[${index}].iconId "${view.iconId}" is ignored at runtime — the matching panels entry owns the rendered icon. Set iconId there instead.`
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
  // Same advisory treatment for process detections (#11613), with NO
  // agent-brand exemption — unlike panels, an unrecognized id here is collapsed
  // to `terminal` by the host at registration so a plugin can't borrow a
  // built-in agent's mark or a built-in tool's detection priority. That makes a
  // brand id like `claude` especially worth warning about: it names a real
  // glyph, so it looks like it works, but the host never honors it.
  for (const [index, tool] of manifest.contributes.processTools.entries()) {
    if (tool.iconId && !isPluginIconId(tool.iconId)) {
      warnings.push(
        `processTools[${index}].iconId "${tool.iconId}" isn't a recognized plugin icon — the host will collapse it and the terminal tab will render the default terminal icon. Known ids: ${knownIds}`
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

  return warnings;
}

/**
 * `engines.daintree` must be an open-ended lower bound, never a caret. Under
 * semver's 0.x rule `^0.11.0` means `>=0.11.0 <0.12.0`, so a caret written
 * against today's release is refused by the host's engine gate on every release
 * after it. The manifest schema only checks that the range parses, so this is
 * the one place the rule is mechanically enforced.
 *
 * Returns the advisory text, or `null` when the range is fine or absent.
 */
export function caretEngineAdvisory(range: string | undefined): string | null {
  if (!range || !range.trimStart().startsWith("^")) return null;
  const lowerBound = range.trim().slice(1).trim();
  return `engines.daintree "${range}" is a caret range — under semver's 0.x rule it resolves to a single minor and the host refuses the plugin on every release after it. Write ">=${lowerBound}" instead.`;
}
