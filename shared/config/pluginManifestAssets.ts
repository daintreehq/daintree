/**
 * The files a plugin manifest points at (#14091). Packaging, archive
 * verification and `daintree-plugin doctor` each used to keep their own list,
 * and they drifted: a tour's scene module was in none of them, so a plugin
 * shipping only `plugin.json` packaged and verified clean. Every entry point
 * now reads this one inventory, so an asset can't pass one gate and fail the
 * next.
 *
 * Pure, with no imports beyond the custom-icon helper (itself import-free):
 * main and the standalone `daintree-plugin` CLI both bundle this module. The
 * manifest is read defensively as `unknown`, because doctor hands over raw
 * JSON that may not have passed the schema.
 *
 * Executable commands (`./` agent and MCP server commands) are left out: on
 * Windows the spawn resolves `./bin/server` to `bin/server.exe`, so the name
 * the manifest writes is not necessarily a file that ships.
 */

import { isPluginCustomIconRef } from "./pluginCustomIcon.js";

export interface PluginManifestAsset {
  /** Manifest location, e.g. `tours[0].componentPath`. */
  field: string;
  /** The reference exactly as the manifest writes it. */
  ref: string;
  /**
   * The plugin-relative file that must exist for the reference to resolve. A
   * leading `./` is stripped and nothing else is normalized: the archive check
   * compares entry names verbatim, so being more lenient anywhere would let a
   * reference pass packaging and then fail verification. An Assistant knowledge
   * skill names a directory, so this is its `SKILL.md`.
   */
  path: string;
  /**
   * `false` only where the runtime has a deliberate fallback that leaves the
   * contribution working: local tour narration, which plays silently without
   * its audio. Everything else breaks or vanishes without its file.
   */
  required: boolean;
  /** An ES module the host imports, as opposed to a file it reads. */
  module: boolean;
  /** Build output the host reads and evaluates as a script, so its directory must survive `.gitignore`. */
  built?: boolean;
}

/** Matches `URL_SCHEME_PREFIX` in the manifest schema's tour audio check. */
const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

export function normalizePluginAssetRef(ref: string): string {
  return ref.startsWith("./") ? ref.slice(2) : ref;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entries(value: unknown): Array<[number, Record<string, unknown>]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[number, Record<string, unknown>]> = [];
  value.forEach((item, index) => {
    const entry = record(item);
    if (entry) out.push([index, entry]);
  });
  return out;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function collectPluginManifestAssets(manifest: unknown): PluginManifestAsset[] {
  const root = record(manifest);
  if (!root) return [];
  const assets: PluginManifestAsset[] = [];
  const add = (
    field: string,
    ref: unknown,
    opts: { required?: boolean; module?: boolean; built?: boolean } = {}
  ) => {
    if (!nonEmptyString(ref)) return;
    assets.push({
      field,
      ref,
      path: normalizePluginAssetRef(ref),
      required: opts.required ?? true,
      module: opts.module ?? false,
      ...(opts.built ? { built: true } : {}),
    });
  };
  const addIcon = (field: string, iconId: unknown) => {
    if (typeof iconId === "string" && isPluginCustomIconRef(iconId)) add(field, iconId);
  };

  add("main", root.main, { module: true });

  const contributes = record(root.contributes);
  if (!contributes) return assets;

  // `experimental_views` was renamed to `views` in the 1.0 freeze and is still
  // read when `views` is absent.
  const viewsKey = Array.isArray(contributes.views) ? "views" : "experimental_views";
  for (const [index, view] of entries(contributes[viewsKey])) {
    add(`${viewsKey}[${index}].componentPath`, view.componentPath, { module: true });
    if (view.location === "sidebar") addIcon(`${viewsKey}[${index}].iconId`, view.iconId);
  }

  for (const [index, tour] of entries(contributes.tours)) {
    add(`tours[${index}].componentPath`, tour.componentPath, { module: true });
    for (const [chapterIndex, chapter] of entries(tour.chapters)) {
      const audioUrl = chapter.audioUrl;
      if (typeof audioUrl === "string" && !URL_SCHEME_PREFIX.test(audioUrl)) {
        add(`tours[${index}].chapters[${chapterIndex}].audioUrl`, audioUrl, { required: false });
      }
    }
  }

  for (const [index, skill] of entries(contributes.skills)) {
    add(`skills[${index}].path`, skill.path);
  }

  const knowledge = record(contributes.assistantKnowledge);
  if (knowledge) {
    add("assistantKnowledge.instructions", knowledge.instructions);
    for (const [index, skill] of entries(knowledge.skills)) {
      if (!nonEmptyString(skill.path)) continue;
      const dir = normalizePluginAssetRef(skill.path).replace(/\/+$/, "");
      assets.push({
        field: `assistantKnowledge.skills[${index}].path`,
        ref: skill.path,
        path: dir === "" || dir === "." ? "SKILL.md" : `${dir}/SKILL.md`,
        required: true,
        module: false,
      });
    }
    for (const [index, reference] of entries(knowledge.references)) {
      add(`assistantKnowledge.references[${index}].path`, reference.path);
    }
  }

  // Element picker guest entries are scripts the host evaluates in a preview
  // page; a resolver entry is an ES module a plugin resolver host imports.
  for (const [index, provider] of entries(contributes.elementPickerProviders)) {
    add(`elementPickerProviders[${index}].guestEntry`, provider.guestEntry, { built: true });
    add(`elementPickerProviders[${index}].resolverEntry`, provider.resolverEntry, {
      built: true,
      module: true,
    });
  }

  for (const [index, theme] of entries(contributes.themes)) {
    add(`themes[${index}].path`, theme.path);
  }

  // Custom SVG icons (#13143) fall back to the generic glyph, but that is a
  // visibly broken plugin rather than a designed fallback, so they count as
  // required. These are the fields the host reads them from.
  for (const group of [
    "panels",
    "toolbarButtons",
    "launchEntries",
    "searchProviders",
    "processTools",
  ]) {
    for (const [index, entry] of entries(contributes[group])) {
      addIcon(`${group}[${index}].iconId`, entry.iconId);
    }
  }
  for (const [index, panel] of entries(contributes.panels)) {
    for (const [slot, item] of entries(panel.toolbar)) {
      addIcon(`panels[${index}].toolbar[${slot}].iconId`, item.iconId);
    }
  }

  return assets;
}

/** The field and reference, plus the file actually looked for when they differ. */
export function describePluginManifestAsset(asset: PluginManifestAsset): string {
  return asset.path === normalizePluginAssetRef(asset.ref)
    ? `${asset.field} "${asset.ref}"`
    : `${asset.field} "${asset.ref}" (expected ${asset.path})`;
}
