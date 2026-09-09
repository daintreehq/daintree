import type { ComponentType } from "react";
import { useBuiltinView } from "@/registry/builtinRendererRegistry";

/**
 * Renderer-side registry for `contributes.fileEditors` (#12323): which
 * built-in plugin offers the file panel's writable Edit mode for which
 * extensions. A plugin's renderer entry registers here at module eval, next to
 * its `registerBuiltinView` call, mirroring its manifest — the main process
 * validates the manifest, the renderer resolves the slot. `FilePane` reads the
 * registry and never imports a plugin.
 *
 * Resolution is enable-aware by construction: {@link useFileEditor} resolves
 * the slot through {@link useBuiltinView}, so a plugin disabled in Preferences
 * drops its Edit mode live and the panel's mode clamp falls back to Source.
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
 * The first registration claiming the file's extension, or null. Pure — no
 * enable gate here; that is {@link useFileEditor}'s job, because it needs the
 * reactive plugin-runtime mirror.
 */
export function resolveFileEditor(filePath: string): FileEditorRegistration | null {
  const ext = extensionOf(filePath);
  if (ext === null) return null;
  return REGISTRY.find((entry) => entry.extensions.includes(ext)) ?? null;
}

export interface ResolvedFileEditor {
  registration: FileEditorRegistration;
  Component: ComponentType<FileEditorViewProps>;
}

/**
 * Reactive resolution for React consumers: the registration for the path,
 * with its slot resolved through the builtin view registry. Null when no
 * plugin claims the extension, when the owning plugin is disabled, or when the
 * slot was never registered (a manifest/renderer drift the
 * `builtinViewRegistrations` test guards).
 */
export function useFileEditor(filePath: string | undefined): ResolvedFileEditor | null {
  const registration = filePath !== undefined ? resolveFileEditor(filePath) : null;
  // Hooks run unconditionally; an empty slot id is the registry's documented
  // "no slot" sentinel and resolves null without a dev warning.
  const Component = useBuiltinView<FileEditorViewProps>(registration?.slot ?? "");
  if (!registration || !Component) return null;
  return { registration, Component };
}

export function __resetFileEditorRegistryForTests(): void {
  REGISTRY.length = 0;
}
