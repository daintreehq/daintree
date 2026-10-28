import { z } from "zod";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";
import { reportDuplicateIds } from "./uniqueness.js";

// A slot-backed file editor resolves through the builtin view registry
// compiled into the host bundle, so only a built-in plugin can back one.
// A view-backed editor mounts one of the plugin's own views and is open to
// every origin (#13809); its `paths` claims are a project plugin's alone,
// because only a project plugin is bound to a project they are relative to.
export function validateFileEditors(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { origin } = context;
  manifest.contributes.fileEditors.forEach((entry, index) => {
    const at = (field: string) => ["contributes", "fileEditors", index, field];
    if ((entry.slot === undefined) === (entry.view === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("view"),
        message: 'A file editor names exactly one of "slot" (built-in plugins) or "view".',
        params: { errorCode: "file_editor_backing_invalid" },
      });
    }
    if (entry.slot !== undefined && (entry.mode !== undefined || entry.paths !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("slot"),
        message:
          'A slot-backed file editor is always an Edit mode matched by extension — "mode" and "paths" belong to a view-backed one.',
        params: { errorCode: "file_editor_backing_invalid" },
      });
    }
    if (entry.view !== undefined && entry.mode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("mode"),
        message: 'A view-backed file editor declares "mode": "edit" or "view".',
        params: { errorCode: "file_editor_mode_missing" },
      });
    }
    if (entry.extensions === undefined && entry.paths === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at("extensions"),
        message:
          'A file editor matches files by "extensions", "paths" or both — it declares neither.',
        params: { errorCode: "file_editor_match_missing" },
      });
    }
    if (entry.slot !== undefined && origin !== "builtin") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "fileEditors", index, "slot"],
        message:
          'contributes.fileEditors[].slot is only available to built-in plugins — the slot resolves through the host-bundled builtin view registry. Back the editor with one of your own views instead: "view" naming a location: "fileEditor" view.',
        params: { errorCode: "fileEditors_slot_builtin_only" },
      });
    }
    if (entry.paths !== undefined && manifest.scope !== "project") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "fileEditors", index, "paths"],
        message:
          'contributes.fileEditors[].paths is only available to a "scope": "project" plugin — the patterns are relative to the project it belongs to. Match by "extensions" instead.',
        params: { errorCode: "fileEditors_paths_project_only" },
      });
    }
    // A default reshapes how a project opens its own files, so it is a
    // project plugin's alone (#13811), and only ever by pattern: an
    // extension default would reach every file of that type.
    if (entry.default === true) {
      if (manifest.scope !== "project") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: at("default"),
          message:
            'contributes.fileEditors[].default is only available to a "scope": "project" plugin — an installed plugin adds an editor, it never decides what a project\'s files open in.',
          params: { errorCode: "fileEditors_default_project_only" },
        });
      } else if (entry.view === undefined || entry.mode !== "edit" || entry.paths === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: at("default"),
          message:
            'A default file editor is a view-backed "mode": "edit" editor with "paths" — the patterns it becomes the default for.',
          params: { errorCode: "fileEditors_default_invalid" },
        });
      }
    }
  });

  // One plugin, one editor per default pattern: two entries naming the same
  // pattern would claim one slot twice, and whichever loaded last would win.
  const defaultPatterns = new Set<string>();
  manifest.contributes.fileEditors.forEach((entry, index) => {
    if (entry.default !== true) return;
    for (const pattern of entry.paths ?? []) {
      if (defaultPatterns.has(pattern)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "fileEditors", index, "paths"],
          message: `"${pattern}" is already the default for another of this plugin's file editors — a pattern opens in one editor.`,
          params: { errorCode: "fileEditors_default_duplicate" },
        });
      }
      defaultPatterns.add(pattern);
    }
  });
}

// A provider reads the previewed page's DOM and runtime, so it is
// disclosed at install like any other capability. A source resolver
// additionally reads the project's files to map what the page reported
// onto authored source.
export function validateElementPickerProviders(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { capabilities } = context;
  manifest.contributes.elementPickerProviders.forEach((provider, index) => {
    if (!capabilities.has("preview:inspect")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "elementPickerProviders", index],
        message:
          'contributes.elementPickerProviders requires the "preview:inspect" capability to be declared in capabilities.',
        params: { errorCode: "preview_inspect_capability_required" },
      });
    }
    if (provider.resolverEntry !== undefined && !capabilities.has("fs:project-read")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "elementPickerProviders", index, "resolverEntry"],
        message:
          'An element picker provider with a resolverEntry requires the "fs:project-read" capability to be declared in capabilities.',
        params: { errorCode: "fs_project_read_capability_required" },
      });
    }
  });
}

export function validateContextProviders(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx
): void {
  reportDuplicateIds(ctx, "contextProviders", manifest.contributes.contextProviders);
  // One plugin answering one prefix twice would leave the second provider
  // unreachable behind the first.
  const claimedPrefixes = new Set<string>();
  manifest.contributes.contextProviders.forEach((provider, index) => {
    if (claimedPrefixes.has(provider.prefix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "contextProviders", index, "prefix"],
        message: `Prefix "${provider.prefix}" is claimed by more than one context provider.`,
      });
    }
    claimedPrefixes.add(provider.prefix);
  });
}

// `forgeProvider.settingsScopeRef` → a declared setting; `viewRefs[]` →
// declared views. Both were validated for shape only before (#10620).
export function validateForgeProviderRefs(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { settingIds, viewIds } = context;
  manifest.contributes.forgeProviders.forEach((provider, index) => {
    if (provider.settingsScopeRef !== undefined && !settingIds.has(provider.settingsScopeRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "forgeProviders", index, "settingsScopeRef"],
        message: `forgeProvider settingsScopeRef "${provider.settingsScopeRef}" matches no contributes.settings[].id.`,
        params: { errorCode: "forge_settings_scope_ref_unknown" },
      });
    }
    provider.viewRefs?.forEach((ref, refIndex) => {
      if (!viewIds.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "forgeProviders", index, "viewRefs", refIndex],
          message: `forgeProvider viewRef "${ref}" matches no contributes.views[].id.`,
          params: { errorCode: "forge_view_ref_unknown" },
        });
      }
    });
  });
}

// A view-backed file editor must name one of this plugin's own
// `location: "fileEditor"` views — anything else would advertise a mode
// that mounts nothing, or mount a panel or settings view somewhere it was
// never written for.
export function validateFileEditorViews(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { viewIds, fileEditorViewIds } = context;
  manifest.contributes.fileEditors.forEach((entry, index) => {
    if (entry.view === undefined || fileEditorViewIds.has(entry.view)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "fileEditors", index, "view"],
      message: viewIds.has(entry.view)
        ? `File editor "${entry.id}" names view "${entry.view}", which is not a location: "fileEditor" view.`
        : `File editor "${entry.id}" names view "${entry.view}", which matches no contributes.views[].id.`,
      params: { errorCode: "file_editor_view_ref_unknown" },
    });
  });
}
