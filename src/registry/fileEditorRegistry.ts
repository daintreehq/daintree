import type { ComponentType } from "react";
import { getBuiltinView, useBuiltinView } from "@/registry/builtinRendererRegistry";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

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

/** Default byte ceiling when a contribution omits `maxBytes`. */
export const DEFAULT_FILE_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

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

function extensionOf(filePath: string): string | null {
  const name = filePath.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  // A dotfile (`.env`) and a bare name (`README`) have no extension to match.
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
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
 * A registration for the file, resolved outside React: the first usable
 * candidate, else the first candidate at all.
 *
 * The fallback is deliberate. `FileEditorBanner` discovers through this
 * function precisely so it can offer to enable the plugin that claims the
 * file, which means a disabled-only answer has to stay visible here. Callers
 * that must not reach a disabled plugin resolve through {@link useFileEditor}
 * instead, which returns null rather than falling back.
 */
export function resolveFileEditor(filePath: string): FileEditorRegistration | null {
  const candidates = candidatesFor(filePath);
  if (candidates.length === 0) return null;
  const { pluginMetaById, disabledPluginIds } = usePluginRuntimeStore.getState();
  // The same usability test the hook applies, so the two never disagree about
  // which candidate is the live one — a banner that hid because a *different*
  // plugin was enabled would leave no route to the editor at all.
  return (
    candidates.find((entry) => isUsable(entry, pluginMetaById, disabledPluginIds)) ??
    candidates[0] ??
    null
  );
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

export function __resetFileEditorRegistryForTests(): void {
  REGISTRY.length = 0;
}
