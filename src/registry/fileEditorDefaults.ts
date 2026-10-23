import { useEffect, useMemo } from "react";
import {
  fileEditorChoiceId,
  fileEditorSlotClaimData,
  fileEditorSlotPattern,
  isFileEditorSlotKey,
  type FileEditorChoice,
  type FileEditorSlotKey,
  type PluginHostedViewDescriptor,
  type ProjectSurfaceChoices,
  type ProjectSurfaceSlotKey,
  type ProjectSurfaceSlotState,
} from "@shared/types/plugin";
import { matchesFileEditorGlob, relativeFilePath } from "@/registry/fileEditorGlob";
import { useProjectStore } from "@/store/projectStore";
import { selectViewProject } from "@/store/viewWorkspace";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";
import {
  surfaceSlotChoice,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { getWorktreePathIndex, getWorktreeSelectionSnapshot } from "@/store/storeAccessors";

/**
 * The editor a project plugin made the default for a file (#13811): which
 * file editor slot covers it, and the editor its owner named.
 */
export interface FileEditorDefault {
  slot: FileEditorSlotKey;
  /** The owning plugin's instance key. */
  pluginId: string;
  /** The editor as an "Edit with…" answer — what a panel opened by it pins. */
  choiceId: FileEditorChoice;
  /**
   * `null` while the user hasn't answered about the slot: the default applies
   * meanwhile and the file panel asks, as a claimed canvas shows and asks.
   */
  choice: "surface" | null;
}

export interface FileEditorDefaultInput {
  slots: Partial<Record<ProjectSurfaceSlotKey, ProjectSurfaceSlotState>>;
  choices: ProjectSurfaceChoices;
  /** Whether the answers are known. Unknown is not unanswered: nothing applies until they are. */
  choicesLoaded: boolean;
  views: readonly PluginHostedViewDescriptor[] | null;
  disabled: ReadonlySet<string>;
  /** The project or worktree root the file's patterns are relative to. */
  rootPath: string;
  filePath: string;
}

/**
 * How specific a pattern is, as `[globstars, literal characters]`. Of two
 * defaults that both match a file, the one that says more about it wins, so a
 * narrower claim is never shadowed by a broader one: fewer `**` segments first
 * (`content/about.json` over the same path under a leading `**`), then more literal
 * characters (`content/about.json` over `content/*.json`).
 */
function specificity(pattern: string): [number, number] {
  const segments = pattern.split("/");
  const globstars = segments.filter((segment) => segment === "**").length;
  let literal = 0;
  for (const segment of segments) {
    if (segment === "**") continue;
    for (const char of segment) if (char !== "*" && char !== "?") literal += 1;
  }
  return [globstars, literal];
}

function compareDefaults(a: FileEditorDefault, b: FileEditorDefault): number {
  const pa = fileEditorSlotPattern(a.slot);
  const pb = fileEditorSlotPattern(b.slot);
  const [globsA, literalA] = specificity(pa);
  const [globsB, literalB] = specificity(pb);
  if (globsA !== globsB) return globsA - globsB;
  if (literalA !== literalB) return literalB - literalA;
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/** Whether the owner's editor is on offer here: its view loaded, enabled, and still the default's. */
function editorOnOffer(
  views: readonly PluginHostedViewDescriptor[],
  disabled: ReadonlySet<string>,
  pluginId: string,
  editorId: string,
  pattern: string
): boolean {
  if (disabled.has(pluginId)) return false;
  return views.some(
    (view) =>
      view.location === "fileEditor" &&
      view.pluginId === pluginId &&
      (view.fileEditors ?? []).some(
        (editor) =>
          editor.id === editorId && editor.mode === "edit" && editor.paths.includes(pattern)
      )
  );
}

/**
 * The default editor for `filePath`, or `null` when none applies: no file
 * editor slot's pattern matches it, the user chose Daintree's own for every
 * one that does, the claimed editor isn't on offer, or the answers or the
 * editors haven't loaded yet. Pure over its inputs.
 *
 * When several defaults match, the most specific pattern wins (see
 * {@link specificity}), then the ordinally first — never the order the claims
 * arrived in.
 */
export function resolveFileEditorDefault(input: FileEditorDefaultInput): FileEditorDefault | null {
  const { slots, choices, choicesLoaded, views, disabled, rootPath, filePath } = input;
  if (!choicesLoaded || views === null) return null;
  const relative = relativeFilePath(rootPath, filePath);
  if (relative === null) return null;
  const matches: FileEditorDefault[] = [];
  for (const slot of Object.keys(slots).filter(isFileEditorSlotKey)) {
    const state = slots[slot];
    if (state === undefined) continue;
    const pattern = fileEditorSlotPattern(slot);
    if (!matchesFileEditorGlob(relative, pattern)) continue;
    const owner = state.options[0];
    const claim = owner === undefined ? null : fileEditorSlotClaimData(owner.value);
    if (owner === undefined || claim === null) continue;
    const choice = surfaceSlotChoice(state, choices[slot]);
    if (choice === "stock") continue;
    if (!editorOnOffer(views, disabled, owner.pluginId, claim.editorId, pattern)) continue;
    matches.push({
      slot,
      pluginId: owner.pluginId,
      choiceId: fileEditorChoiceId(owner.pluginId, claim.editorId),
      choice,
    });
  }
  return matches.sort(compareDefaults)[0] ?? null;
}

/**
 * {@link resolveFileEditorDefault} as a subscribed read for a file panel, which
 * already knows the root its file is read through. `null` while `enabled` is
 * false — a dialog, or a file outside every governed root.
 */
export function useFileEditorDefault(
  filePath: string | undefined,
  rootPath: string,
  enabled: boolean
): FileEditorDefault | null {
  const initSurfaces = usePluginProjectSurfacesStore((s) => s.init);
  useEffect(() => {
    initSurfaces();
  }, [initSurfaces]);
  const slots = usePluginProjectSurfacesStore((s) => s.slots);
  const choices = usePluginProjectSurfacesStore((s) => s.choices);
  const choicesLoaded = usePluginProjectSurfacesStore((s) => s.choicesLoaded);
  const views = usePluginHostedViewsStore((s) => s.views);
  const disabled = usePluginRuntimeStore((s) => s.disabledPluginIds);
  return useMemo(
    () =>
      !enabled || filePath === undefined
        ? null
        : resolveFileEditorDefault({
            slots,
            choices,
            choicesLoaded,
            views,
            disabled,
            rootPath,
            filePath,
          }),
    [enabled, filePath, rootPath, slots, choices, choicesLoaded, views, disabled]
  );
}

/**
 * The root a default's patterns are matched against for a file a new panel is
 * about to show — the one that panel's pane will read it through, so the two
 * never disagree about whether a pattern matches: the worktree the panel is
 * bound to (the active one), else the deepest worktree containing the file,
 * else this view's own project. Containment, never a caller's say-so, so a
 * root passed in to resolve a relative path cannot move the file.
 */
function patternRoot(filePath: string): string | null {
  const index = getWorktreePathIndex();
  const activeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
  const panelRoot = activeId === null ? undefined : index?.get(activeId);
  let deepest: string | undefined;
  for (const root of index?.values() ?? []) {
    if (relativeFilePath(root, filePath) === null) continue;
    if (deepest === undefined || root.length > deepest.length) deepest = root;
  }
  // The view's own project, not the globally current one another window can
  // repoint.
  const project = selectViewProject(getViewWorkspaceId(), useProjectStore.getState())?.path;
  return (
    [panelRoot, deepest, project].find(
      (root): root is string => !!root && relativeFilePath(root, filePath) !== null
    ) ?? null
  );
}

/**
 * {@link resolveFileEditorDefault} read once, outside React, against this
 * project view's stores as they stand — for an opener deciding where a file
 * goes. Starts the stores it reads if nothing on screen has yet; until their
 * first reads land, nothing applies.
 */
export function currentFileEditorDefault(filePath: string): FileEditorDefault | null {
  const surfaces = usePluginProjectSurfacesStore.getState();
  surfaces.init();
  const hosted = usePluginHostedViewsStore.getState();
  hosted.init();
  const rootPath = patternRoot(filePath);
  if (rootPath === null) return null;
  return resolveFileEditorDefault({
    slots: surfaces.slots,
    choices: surfaces.choices,
    choicesLoaded: surfaces.choicesLoaded,
    views: hosted.views,
    disabled: usePluginRuntimeStore.getState().disabledPluginIds,
    rootPath,
    filePath,
  });
}
