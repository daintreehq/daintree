import { useEffect, useMemo, type ComponentType } from "react";
import {
  DEFAULT_FILE_EDITOR_MAX_BYTES,
  HOST_FILE_EDITOR_CHOICE,
  fileEditorChoiceId,
  type FileEditorChoice,
  type FileEditorChoiceKey,
  type FileEditorChoices,
  type FileEditorMode,
  type HostedFileEditorDescriptor,
  type PluginHostedViewDescriptor,
} from "@shared/types/plugin";
import { getBuiltinView, useBuiltinView } from "@/registry/builtinRendererRegistry";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";
import { extensionOf, matchesFileEditorGlob, relativeFilePath } from "@/registry/fileEditorGlob";

/**
 * Renderer-side registry for `contributes.fileEditors` (#12323): which
 * built-in plugin offers the file browser and file panel's writable Edit mode for which
 * extensions. A plugin's renderer entry registers here at module eval, next to
 * its `registerBuiltinView` call, mirroring its manifest — the main process
 * validates the manifest, the renderer resolves the slot. `FileBrowserViewer` and `FilePane` read the
 * registry and never imports a plugin.
 *
 * Resolution is enable-aware: {@link useFileEditor} considers every
 * registration claiming the extension and picks the first one whose plugin is
 * loaded and enabled, so a disabled registration cannot mask an enabled later
 * one. Order is registration order, which is deterministic (built-in renderer
 * entries are globbed in a fixed order); an explicit user-facing "open with"
 * preference is a later step and is deliberately not invented here.
 */

export interface FileEditorRegistration {
  /** `contributes.fileEditors[].id`, bare (the host namespaces it for display only). */
  id: string;
  /** Owning plugin's manifest name — the enable gate the slot resolves under. */
  pluginId: string;
  /** Builtin view id the plugin registered for the editor surface. */
  slot: string;
  /** Lower-case extensions without the dot. */
  extensions: readonly string[];
  /** Byte ceiling the editor accepts; the file panel refuses larger files. */
  maxBytes: number;
}

/**
 * What the file panel hands the editor view. Everything the editor needs to
 * fix the document's identity is here at mount: the file, the root the panel
 * reads through, the containing worktree and the project. The editor must
 * never re-derive these from whatever project is active when an async
 * operation completes.
 */
export interface FileEditorViewProps {
  panelId: string;
  filePath: string;
  fileName: string;
  /** Worktree or project root containing the file — never the parent-directory fallback. */
  rootPath: string;
  worktreePath: string | null;
  projectId: string;
  /** The Source view's soft-wrap preference; Edit honours the same toggle. */
  wrapLines: boolean;
  isFocused: boolean;
  /** The panel's disk-change signal, composed the same way Source mode's is. */
  changeTick: number | undefined;
  /** The toolbar's "Open in editor" route, offered when the document can't be edited here. */
  onOpenExternalEditor: () => void;
}

export { DEFAULT_FILE_EDITOR_MAX_BYTES };

const REGISTRY: FileEditorRegistration[] = [];

export function registerFileEditor(
  registration: Omit<FileEditorRegistration, "maxBytes"> & { maxBytes?: number }
): () => void {
  const entry: FileEditorRegistration = {
    ...registration,
    extensions: registration.extensions.map((ext) => ext.toLowerCase()),
    maxBytes: registration.maxBytes ?? DEFAULT_FILE_EDITOR_MAX_BYTES,
  };
  REGISTRY.push(entry);
  return () => {
    const index = REGISTRY.indexOf(entry);
    if (index >= 0) REGISTRY.splice(index, 1);
  };
}

/**
 * Every registration claiming the file's extension, in registration order.
 * Pure — no enable gate.
 */
function candidatesFor(filePath: string): readonly FileEditorRegistration[] {
  const ext = extensionOf(filePath);
  if (ext === null) return [];
  return REGISTRY.filter((entry) => entry.extensions.includes(ext));
}

/**
 * Loaded and enabled right now — the same gate `devPreviewToolRegistry`
 * applies — and its slot actually present, because a candidate whose renderer
 * entry never registered has no editor to offer and must not shadow a later
 * one that has.
 */
function isUsable(
  registration: FileEditorRegistration,
  known: ReadonlyMap<string, unknown>,
  disabled: ReadonlySet<string>
): boolean {
  return (
    known.has(registration.pluginId) &&
    !disabled.has(registration.pluginId) &&
    getBuiltinView(registration.slot) !== null
  );
}

/**
 * The first usable candidate for the file, else the first candidate at all.
 *
 * The fallback is deliberate. `FileEditorBanner` discovers this way precisely
 * so it can offer to enable the plugin that claims the file, which means a
 * disabled-only answer has to stay visible. Callers that must not reach a
 * disabled plugin resolve through {@link useFileEditor} instead, which returns
 * null rather than falling back.
 *
 * The usability test is the one the hooks apply, so the two never disagree
 * about which candidate is the live one — a banner that hid because a
 * *different* plugin was enabled would leave no route to the editor at all.
 */
function pickRegistration(
  filePath: string,
  known: ReadonlyMap<string, unknown>,
  disabled: ReadonlySet<string>
): FileEditorRegistration | null {
  const candidates = candidatesFor(filePath);
  if (candidates.length === 0) return null;
  return candidates.find((entry) => isUsable(entry, known, disabled)) ?? candidates[0] ?? null;
}

/**
 * {@link pickRegistration} resolved outside React, against the runtime store as
 * it stands right now. For callers that are not rendering; a component reads
 * through {@link useResolvedFileEditor} so it re-resolves when the store moves.
 */
export function resolveFileEditor(filePath: string): FileEditorRegistration | null {
  const { pluginMetaById, disabledPluginIds } = usePluginRuntimeStore.getState();
  return pickRegistration(filePath, pluginMetaById, disabledPluginIds);
}

/**
 * {@link resolveFileEditor} as a subscribed read: the same fallback-bearing
 * answer, but recomputed when either half of the plugin-runtime mirror moves,
 * so a Preferences toggle re-resolves instead of leaving a stale registration
 * on screen. Both selectors return the stored collections themselves, so a
 * toggle that moves neither costs nothing.
 */
export function useResolvedFileEditor(filePath: string): FileEditorRegistration | null {
  const known = usePluginRuntimeStore((s) => s.pluginMetaById);
  const disabled = usePluginRuntimeStore((s) => s.disabledPluginIds);
  return pickRegistration(filePath, known, disabled);
}

export interface ResolvedFileEditor {
  registration: FileEditorRegistration;
  Component: ComponentType<FileEditorViewProps>;
}

/**
 * Reactive resolution for React consumers: the first registration for the path
 * whose plugin is loaded and enabled and whose slot exists, with that slot's
 * component. Null when no plugin claims the extension, when every claimant is
 * disabled or not yet known, or when no claimant's slot was registered (a
 * manifest/renderer drift the `builtinViewRegistrations` test guards).
 *
 * A plugin that is claimed but absent from `pluginMetaById` counts as
 * unavailable: before the first runtime snapshot lands we don't know whether it
 * is enabled, and a default-off editor must not flash an Edit mode it will lose.
 *
 * Subscribing to both halves of the mirror is what makes a Preferences toggle
 * re-resolve rather than merely re-render the previously chosen slot. Both
 * selectors return the stored collections themselves, so a toggle that doesn't
 * move either one costs nothing. `useBuiltinView` runs unconditionally below
 * and carries the `init()` pull, so no extra effect is needed here.
 */
export function useFileEditor(filePath: string | undefined): ResolvedFileEditor | null {
  const known = usePluginRuntimeStore((s) => s.pluginMetaById);
  const disabled = usePluginRuntimeStore((s) => s.disabledPluginIds);
  const registration =
    filePath === undefined
      ? null
      : (candidatesFor(filePath).find((entry) => isUsable(entry, known, disabled)) ?? null);
  // Hooks run unconditionally; an empty slot id is the registry's documented
  // "no slot" sentinel and resolves null without a dev warning.
  const Component = useBuiltinView<FileEditorViewProps>(registration?.slot ?? "");
  if (!registration || !Component) return null;
  return { registration, Component };
}

/**
 * A view-backed file editor from an installed or project plugin (#13809),
 * resolved from the project view's hosted-view snapshot — which main has
 * already narrowed to plugins this project may see, so a project plugin's
 * editors never reach another project.
 */
export interface PluginFileEditorCandidate {
  /** The "Edit with…" answer that picks this editor. */
  choiceId: FileEditorChoice;
  /** The plugin's runtime instance key. */
  pluginId: string;
  /** The plugin's display name, the mode's label. */
  pluginName: string;
  editor: HostedFileEditorDescriptor;
  /** The `location: "fileEditor"` view the editor mounts. */
  view: PluginHostedViewDescriptor;
}

/**
 * The "Edit with…" key a file's answer is remembered under: the mode and the
 * lower-case extension, or `*` for a file without one.
 */
export function fileEditorChoiceKey(mode: FileEditorMode, filePath: string): FileEditorChoiceKey {
  const ext = extensionOf(filePath);
  // Only a suffix a manifest could name is a key of its own; anything else
  // (a path claim on `notes.draft-v2`) shares the extensionless answer.
  return `${mode}:${ext !== null && /^[a-z0-9]{1,16}$/.test(ext) ? ext : "*"}`;
}

function editorMatches(
  editor: HostedFileEditorDescriptor,
  ext: string | null,
  relative: string | null
): boolean {
  if (ext !== null && editor.extensions.includes(ext)) return true;
  return (
    relative !== null && editor.paths.some((pattern) => matchesFileEditorGlob(relative, pattern))
  );
}

/**
 * Every plugin editor of `mode` claiming the file, in a deterministic order —
 * plugin instance key, then editor id — so load order never decides which one
 * opens. Pure over its inputs.
 */
export function pluginFileEditorCandidates(
  views: readonly PluginHostedViewDescriptor[] | null,
  options: {
    filePath: string;
    rootPath: string;
    mode: FileEditorMode;
    disabled: ReadonlySet<string>;
    displayNameOf: (pluginId: string) => string;
  }
): PluginFileEditorCandidate[] {
  if (views === null) return [];
  const ext = extensionOf(options.filePath);
  const relative = relativeFilePath(options.rootPath, options.filePath);
  const out: PluginFileEditorCandidate[] = [];
  for (const view of views) {
    if (view.location !== "fileEditor" || options.disabled.has(view.pluginId)) continue;
    for (const editor of view.fileEditors ?? []) {
      if (editor.mode !== options.mode || !editorMatches(editor, ext, relative)) continue;
      out.push({
        choiceId: fileEditorChoiceId(view.pluginId, editor.id),
        pluginId: view.pluginId,
        pluginName: options.displayNameOf(view.pluginId),
        editor,
        view,
      });
    }
  }
  return out.sort((a, b) =>
    a.pluginId === b.pluginId
      ? a.editor.id.localeCompare(b.editor.id)
      : a.pluginId.localeCompare(b.pluginId)
  );
}

/**
 * {@link pluginFileEditorCandidates} as a subscribed read against this project
 * view's hosted-view snapshot and the plugin runtime mirror.
 */
export function usePluginFileEditorCandidates(
  filePath: string | undefined,
  rootPath: string,
  mode: FileEditorMode,
  enabled = true
): PluginFileEditorCandidate[] {
  const initHosted = usePluginHostedViewsStore((s) => s.init);
  useEffect(() => {
    initHosted();
  }, [initHosted]);
  const views = usePluginHostedViewsStore((s) => s.views);
  const meta = usePluginRuntimeStore((s) => s.pluginMetaById);
  const disabled = usePluginRuntimeStore((s) => s.disabledPluginIds);
  return useMemo(
    () =>
      !enabled || filePath === undefined
        ? []
        : pluginFileEditorCandidates(views, {
            filePath,
            rootPath,
            mode,
            disabled,
            displayNameOf: (pluginId) => meta.get(pluginId)?.displayName ?? pluginId,
          }),
    [enabled, filePath, rootPath, mode, views, meta, disabled]
  );
}

/**
 * Which option a mode opens with. The user's remembered answer wins whenever
 * it names an option still on offer; otherwise the first option, which is the
 * host's own when the host has one — an installed or project editor adds a
 * choice, it never displaces the built-in editor or renderer by itself.
 */
export function pickFileEditorChoice(
  options: readonly FileEditorChoice[],
  choices: FileEditorChoices,
  key: FileEditorChoiceKey
): FileEditorChoice | null {
  const remembered = choices[key];
  if (remembered !== undefined && options.includes(remembered)) return remembered;
  return options[0] ?? null;
}

export { HOST_FILE_EDITOR_CHOICE };

export function __resetFileEditorRegistryForTests(): void {
  REGISTRY.length = 0;
}
