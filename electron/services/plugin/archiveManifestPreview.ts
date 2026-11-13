import { resolvePluginCategory } from "../../../shared/config/pluginCategoryRegistry.js";
import { readArchiveManifest, readArchiveTemplateProjectPlugins } from "../PluginArchive.js";
import type { PluginArchiveManifestPreview } from "../../../shared/types/plugin.js";

/**
 * The install-time disclosure of a `.dntr` archive, read without extracting it.
 * One projection for every route that asks before installing, an archive opened
 * from the operating system (#11280) and a URL install (#16776), so both
 * confirmations show the same identity and permissions.
 */

// Manifest strings are attacker-controlled and only bounded by the archive size
// cap, so clamp what crosses IPC into the dialog. The full value still reaches
// the installer, which does its own validation.
const PREVIEW_TEXT_MAX = 200;

// Unicode format controls (bidi overrides, zero-widths, line/paragraph
// separators, C0/C1) can visually reorder or overpaint the trusted text beside
// an interpolated field — U+202E flips everything rendered after it, which
// would let a manifest spoof the dialog's own copy. Stripped before display;
// RTL letters themselves pass through untouched. React text-node escaping
// handles markup, not these.
const UNSAFE_DISPLAY_CHARS =
  // eslint-disable-next-line no-control-regex -- deliberately strips C0/C1 controls from attacker-controlled display text
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function sanitizePreviewText(value: string): string {
  return value.replace(UNSAFE_DISPLAY_CHARS, "");
}

export function clampPreviewText(value: string): string {
  const clean = sanitizePreviewText(value);
  return clean.length > PREVIEW_TEXT_MAX ? `${clean.slice(0, PREVIEW_TEXT_MAX)}…` : clean;
}

/** Read an archive's manifest and project it for the install confirmation. */
export async function readArchiveManifestPreview(
  archivePath: string
): Promise<PluginArchiveManifestPreview> {
  const manifest = await readArchiveManifest(archivePath);
  const recipeContributions = manifest.contributes?.recipes ?? [];
  const templateContributions = manifest.contributes?.projectTemplates ?? [];
  // Only archives that declare templates pay for the entry scan.
  const templateProjectPlugins =
    templateContributions.length > 0
      ? await readArchiveTemplateProjectPlugins(
          archivePath,
          templateContributions.map((template) => template.id)
        )
      : new Map<string, string[]>();
  return {
    name: manifest.name,
    displayName: manifest.displayName && clampPreviewText(manifest.displayName),
    version: manifest.version,
    category: resolvePluginCategory(manifest),
    authors: (manifest.authors ?? []).map((author) => ({
      ...author,
      name: clampPreviewText(author.name),
      ...(author.role !== undefined ? { role: sanitizePreviewText(author.role) } : {}),
    })),
    capabilities: manifest.capabilities ?? [],
    // Recipes are executable content that ships with NO capability to
    // advertise it, so the install confirmation is the only place a user sees
    // them before approving (#11860). Names are plugin-author-controlled and
    // cross IPC into a dialog, so they get the same clamp/sanitize treatment as
    // author names.
    // Optional access even though a parsed manifest always materializes
    // `contributes`: callers fail an archive closed on any throw, so a manifest
    // shape that surprises us must degrade to "no recipes disclosed" rather
    // than reject an otherwise-valid plugin.
    recipes: {
      count: recipeContributions.length,
      // Every name, not a readable subset. The subset existed so a large
      // manifest couldn't push the capability rows off-screen, but truncating
      // here made the dialog's "+N more" name executable content that nothing
      // downstream could reach — on a D2 confirm, where a count is explicitly
      // not a preview (#12001). The list is already bounded by the schema at 50
      // recipes, and each name by `clampPreviewText` at 200 characters, so the
      // payload is capped regardless; the dialog bounds the viewport instead.
      names: recipeContributions.map((recipe) => clampPreviewText(recipe.name)),
    },
    // Templates write files only after the Create project dialog lists every
    // one, but a project plugin inside one asks for trust when that project
    // first opens — so it is named here, before install (#13825). Folder names
    // come from archive entry names, which are author-controlled, so they get
    // the same clamp as titles.
    projectTemplates: templateContributions.map((template) => ({
      title: clampPreviewText(template.title),
      projectPlugins: (templateProjectPlugins.get(template.id) ?? []).map(clampPreviewText),
    })),
    // An agent declaring its CLI's bypass flag can run without permission
    // prompts once the person's setting allows it, so it is named at install
    // (#16374). Names are author-controlled.
    permissionBypassAgents: (manifest.contributes?.agents ?? [])
      .filter((agent) => (agent.permissionBypassArgs?.length ?? 0) > 0)
      .map((agent) => clampPreviewText(agent.name)),
  };
}
