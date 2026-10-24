// View contributions and the project surfaces that mount them.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import {
  SIDEBAR_VIEW_NAME_MAX_LENGTH,
  SIDEBAR_VIEW_PRIORITY_MAX,
  SIDEBAR_VIEW_PRIORITY_MIN,
} from "../../../shared/types/plugin.js";
import type { ViewContribution } from "../../../shared/types/plugin.js";
import { parse as parseWhenClause } from "../../../shared/utils/whenClause/parser.js";
import type { ASTNode as WhenClauseNode } from "../../../shared/utils/whenClause/types.js";
import { isSafePluginAssetPath } from "./common.js";

/** Whether a `when` expression reads `key`; an unparseable one reads nothing. */
export function whenClauseReads(expression: string, key: string): boolean {
  let root: WhenClauseNode;
  try {
    root = parseWhenClause(expression);
  } catch {
    return false;
  }
  const visit = (node: WhenClauseNode): boolean => {
    switch (node.kind) {
      case "identifier":
        return node.path[0] === key;
      case "unary":
        return visit(node.operand);
      case "binary":
        return visit(node.left) || visit(node.right);
      default:
        return false;
    }
  };
  return visit(root);
}

/** Where a view other than a sidebar view takes its display from. */
export const VIEW_DISPLAY_SOURCE: Record<
  Exclude<ViewContribution["location"], "sidebar">,
  string
> = {
  panel: "the matching panel",
  settings: "the plugin's settings home",
  fileEditor: "the file panel, which labels it with the plugin's name",
};

/**
 * View contribution. A `location: "panel"` view renders into a
 * `contributes.panels` entry with a matching `id`; at plugin load
 * (`PluginService.loadPlugin`) the panels loop attaches the view's
 * `componentPath` to that panel kind. A panel view whose `id` matches no panel
 * is rejected by the manifest-level `superRefine` (#10620) — it would otherwise
 * silently never render. A `location: "settings"` view is the plugin's custom
 * settings section instead: it names no panel, and a manifest may declare at
 * most one. A `location: "fileEditor"` view backs a view-backed
 * `contributes.fileEditors` entry: it names no panel and mounts only inside the
 * file panel. A `location: "sidebar"` view is one of the sidebar's views, chosen
 * from the header switcher beside the built-in worktree list; it names no
 * panel either, and it alone carries the display fields a switcher entry
 * needs (`name`, `iconId`, `priority`, `when`). Contributed via the stable
 * `contributes.views` key (the pre-1.0 `experimental_views` name is still
 * accepted as a deprecated alias). See `docs/plugins/architecture.md`.
 */
const SETTINGS_VIEW_TITLE_MAX_LENGTH = 80;

const SETTINGS_VIEW_DESCRIPTION_MAX_LENGTH = 200;

const SETTINGS_VIEW_PAGES_MAX = 20;

/** One page of a settings view's `pages`: navigation inside the plugin's settings home. */
const SettingsViewPageSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().trim().min(1).max(SETTINGS_VIEW_TITLE_MAX_LENGTH),
    description: z.string().trim().min(1).max(SETTINGS_VIEW_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .strict();

export const ViewContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    componentPath: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "componentPath must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    // `"settings"` is the plugin's custom settings section: tied to no panel,
    // at most one per manifest (both checked in the manifest `superRefine`),
    // and mounted in the plugin's settings home below its declared fields.
    // `"fileEditor"` backs a view-backed `contributes.fileEditors` entry and
    // mounts only inside the file panel; `"sidebar"` mounts below the sidebar
    // header when chosen in its switcher.
    location: z.enum(["panel", "settings", "fileEditor", "sidebar"]),
    // For a panel view `iconId` is advisory only — the SDK `validate` command
    // flags an unrenderable id, but at runtime the matching `contributes.panels`
    // entry owns the rendered icon (the panels loop reads `panel.iconId`, never
    // the view's). A sidebar view has no panel, so its own `iconId` is the
    // switcher entry's glyph.
    iconId: z.string().min(1).optional(),
    // Sidebar views only (the manifest `superRefine` rejects them elsewhere): a
    // panel's display metadata belongs to the matching panel, which is why
    // these were removed from panel views in #10888, but a sidebar view has no
    // panel to borrow them from. `name` is required there.
    name: z.string().trim().min(1).max(SIDEBAR_VIEW_NAME_MAX_LENGTH).optional(),
    priority: z
      .number()
      .int()
      .min(SIDEBAR_VIEW_PRIORITY_MIN)
      .max(SIDEBAR_VIEW_PRIORITY_MAX)
      .optional(),
    when: z.string().min(1).optional(),
    // Settings views only (the manifest `superRefine` rejects them elsewhere):
    // what settings search shows for the custom section, and the pages the
    // host lists under it. Display and navigation only — no storage, scope or
    // permission rides on a page.
    title: z.string().trim().min(1).max(SETTINGS_VIEW_TITLE_MAX_LENGTH).optional(),
    description: z.string().trim().min(1).max(SETTINGS_VIEW_DESCRIPTION_MAX_LENGTH).optional(),
    pages: z
      .array(SettingsViewPageSchema)
      .min(1)
      .max(SETTINGS_VIEW_PAGES_MAX)
      .superRefine((pages, ctx) => {
        const seen = new Set<string>();
        pages.forEach((page, index) => {
          if (seen.has(page.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, "id"],
              message: `Settings page id "${page.id}" is declared twice — search and deep links name a page by its id.`,
              params: { errorCode: "settings_view_page_duplicate" },
            });
          }
          seen.add(page.id);
        });
      })
      .optional(),
  })
  .strict();

/**
 * A surface slot that renders a plugin view: `viewId` names an entry in this
 * manifest's own `contributes.views`, cross-checked in `superRefine` exactly
 * like `forgeProviders.viewRefs` (#10620) — a dangling id would mount nothing
 * and leave the slot blank with no diagnostic.
 */
export const SurfaceViewSlotSchema = z
  .object({
    viewId: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  })
  .strict();

/**
 * `contributes.surfaces` (§7.8) — the project surfaces a project-local plugin
 * may own, so a project can present as a purpose-built application rather than
 * as a host with one extra panel.
 *
 * Additive and slot-replacing only. Nothing here removes host chrome: the
 * project switcher, the worktree dashboard and the stock launcher stay
 * reachable in every case, which is the boundary that keeps a broken plugin
 * from stranding the user with no way back. Available to `scope: "project"`
 * plugins alone — an installed plugin claiming a project's surfaces is exactly
 * what locality is supposed to rule out. Each key is a slot in
 * `PROJECT_SURFACE_SLOT_CATALOGUE`; at most one plugin holds an exclusive slot
 * per project, arbitrated at load by `PluginSurfaceRegistry` in a fixed order
 * (project plugins first, then the lower manifest id), and every other claimant
 * is refused by name.
 *
 * `emptyCanvas` stands in for the launcher while the grid is empty;
 * `projectHome` is a persistent Home the main area can switch to beside the
 * grid, which stays one click away; `worktreeCreate` opens a view as the New
 * worktree dialog, with the stock dialog one click away.
 *
 * `defaultLayout` (#13782) is not a slot: it replaces nothing the host draws.
 * It names one of this manifest's own `contributes.layouts`, which the host
 * opens once, on the project's first open on this machine, while the grid and
 * dock are still empty — and offers instead once the user has opened anything.
 * Its recipes never start on their own; they wait as click-to-start entries.
 */
export const SurfaceContributionsSchema = z
  .object({
    emptyCanvas: SurfaceViewSlotSchema.optional(),
    projectHome: SurfaceViewSlotSchema.optional(),
    worktreeCreate: SurfaceViewSlotSchema.optional(),
    defaultLayout: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
  })
  .strict();
