import { z } from "zod";
import {
  PROJECT_SURFACE_SLOTS,
  PROJECT_SURFACE_SLOT_CATALOGUE,
} from "../../../../shared/types/plugin.js";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";
import { VIEW_DISPLAY_SOURCE, whenClauseReads } from "../views.js";

// `surfaces.*.viewId` → a declared view, the same dangling-reference
// treatment `forgeProviders.viewRefs` gets above: an id matching no
// contributed view mounts nothing, so the slot the plugin claimed renders
// blank with no diagnostic.
export function validateSurfaceViews(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { viewIds, settingsViewIds, fileEditorViewIds, sidebarViewIds, ptyPanelIds } = context;
  for (const slot of PROJECT_SURFACE_SLOTS) {
    if (PROJECT_SURFACE_SLOT_CATALOGUE[slot].claim !== "view") continue;
    const claim = manifest.contributes.surfaces[slot];
    if (claim === undefined) continue;
    if (!viewIds.has(claim.viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "surfaces", slot, "viewId"],
        message: `surfaces.${slot}.viewId "${claim.viewId}" matches no contributes.views[].id.`,
        params: { errorCode: "surface_view_ref_unknown" },
      });
      continue;
    }
    // A surface mounts through the claimed view's panel kind, and a
    // settings view has none.
    if (settingsViewIds.has(claim.viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "surfaces", slot, "viewId"],
        message: `surfaces.${slot}.viewId "${claim.viewId}" names a location: "settings" view — a surface draws a panel view, and a settings view renders only in the plugin's settings.`,
        params: { errorCode: "surface_view_ref_settings" },
      });
      continue;
    }
    // Nor does a file editor view, which mounts only in the file panel.
    if (fileEditorViewIds.has(claim.viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "surfaces", slot, "viewId"],
        message: `surfaces.${slot}.viewId "${claim.viewId}" names a location: "fileEditor" view — a surface draws a panel view, and a file editor view renders only in the file panel.`,
        params: { errorCode: "surface_view_ref_file_editor" },
      });
      continue;
    }
    if (sidebarViewIds.has(claim.viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "surfaces", slot, "viewId"],
        message: `surfaces.${slot}.viewId "${claim.viewId}" names a location: "sidebar" view — a surface draws a panel view, and a sidebar view renders only in the sidebar.`,
        params: { errorCode: "surface_view_ref_sidebar" },
      });
      continue;
    }
    // A PTY panel is rendered by TerminalPane, so its matching view is
    // ignored at load and no component path is ever attached. The claim
    // would then hold the project's slot against every other plugin while
    // rendering nothing — worse than not claiming it at all.
    if (ptyPanelIds.has(claim.viewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "surfaces", slot, "viewId"],
        message: `surfaces.${slot}.viewId "${claim.viewId}" names a panel with hasPty: true — PTY panels are rendered by the terminal host and never load the view module, so the surface would hold the slot and draw nothing.`,
        params: { errorCode: "surface_view_ref_pty" },
      });
    }
  }
}

// `surfaces.defaultLayout` → a declared layout. A dangling id would leave
// the project's first open blank with nothing to say why.
export function validateDefaultLayout(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  const defaultLayout = manifest.contributes.surfaces.defaultLayout;
  if (
    defaultLayout !== undefined &&
    !manifest.contributes.layouts.some((layout) => layout.id === defaultLayout)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "surfaces", "defaultLayout"],
      message: `surfaces.defaultLayout "${defaultLayout}" matches no contributes.layouts[].id.`,
      params: { errorCode: "surface_default_layout_unknown" },
    });
  }
}

// A settings view is the plugin's one custom settings section. It renders
// into the plugin's settings home, not a panel, so it may not share an id
// with a panel (the panels loop would otherwise attach it as that panel's
// view), and a second one has nowhere to go.
export function validateViews(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { panelIds } = context;
  let settingsViewSeen = false;
  manifest.contributes.views.forEach((view, index) => {
    // What only the settings home reads; a panel or file editor takes its
    // display from elsewhere and has no pages to list.
    if (view.location !== "settings") {
      for (const field of ["title", "description", "pages"] as const) {
        if (view[field] === undefined) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "views", index, field],
          message: `View "${view.id}" sets ${field}, which only a location: "settings" view uses — it describes the plugin's custom settings section, and a ${view.location} view is not one.`,
          params: { errorCode: "view_settings_field_misplaced" },
        });
      }
    }
    if (view.location === "sidebar") {
      if (view.name === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "views", index, "name"],
          message: `Sidebar view "${view.id}" has no name — the sidebar switcher lists it by name.`,
          params: { errorCode: "sidebar_view_name_missing" },
        });
      }
      // Same reason as a settings view: the panels loop would attach it as
      // that panel's view.
      if (panelIds.has(view.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "views", index, "id"],
          message: `Sidebar view "${view.id}" shares its id with a contributes.panels entry — a sidebar view renders in the sidebar, not a panel, so give it an id of its own.`,
          params: { errorCode: "sidebar_view_panel_id_collision" },
        });
      }
      // Which sidebar view shows is decided from which ones apply, so one
      // whose availability hangs on that answer has no stable answer.
      if (view.when !== undefined && whenClauseReads(view.when, "activeSidebarView")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "views", index, "when"],
          message: `Sidebar view "${view.id}" has a when that reads activeSidebarView — which sidebar view shows depends on which ones apply, so a sidebar view's own when can't depend on it.`,
          params: { errorCode: "sidebar_view_when_reads_active_view" },
        });
      }
      return;
    }
    // Display fields only a sidebar switcher entry reads; elsewhere the
    // runtime would silently ignore them (#10888).
    for (const field of ["name", "priority", "when"] as const) {
      if (view[field] === undefined) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "views", index, field],
        message: `View "${view.id}" sets ${field}, which only a location: "sidebar" view uses — a ${view.location} view takes its display from ${VIEW_DISPLAY_SOURCE[view.location]}.`,
        params: { errorCode: "view_sidebar_field_misplaced" },
      });
    }
    if (view.location === "fileEditor") {
      // Mounted only inside the file panel, never as a panel, so it must
      // not share an id with one (the panels loop would attach it there).
      if (panelIds.has(view.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "views", index, "id"],
          message: `File editor view "${view.id}" shares its id with a contributes.panels entry — a file editor view renders in the file panel, not a panel of its own, so give it an id of its own.`,
          params: { errorCode: "file_editor_view_panel_id_collision" },
        });
      }
      return;
    }
    if (view.location === "settings") {
      if (settingsViewSeen) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "views", index, "location"],
          message: `View "${view.id}" is a second location: "settings" view — a plugin has one settings section, so declare at most one.`,
          params: { errorCode: "settings_view_duplicate" },
        });
      }
      settingsViewSeen = true;
      if (panelIds.has(view.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "views", index, "id"],
          message: `Settings view "${view.id}" shares its id with a contributes.panels entry — a settings view renders in the plugin's settings, not a panel, so give it an id of its own.`,
          params: { errorCode: "settings_view_panel_id_collision" },
        });
      }
      return;
    }
    if (!panelIds.has(view.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "views", index, "id"],
        message: `View "${view.id}" has no matching contributes.panels[].id — a view renders into a panel of the same id, so it would never be shown.`,
        params: { errorCode: "view_panel_ref_unknown" },
      });
    }
  });
}
