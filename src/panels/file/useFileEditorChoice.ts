import { useEffect, useMemo } from "react";
import type { FileViewMode } from "@shared/types/panel";
import {
  HOST_FILE_EDITOR_CHOICE,
  fileEditorChoiceKey,
  pickFileEditorChoice,
  useFileEditor,
  usePluginFileEditorCandidates,
  type PluginFileEditorCandidate,
} from "@/registry/fileEditorRegistry";
import { useFileEditorDefault } from "@/registry/fileEditorDefaults";
import { useFileEditorChoicesStore } from "@/store/fileEditorChoicesStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import { isPluginFileDocumentIdentity } from "@/services/plugin/pluginFileDocumentIdentity";
import type { FileEditorPickerOption } from "./FileEditorPicker";

/** Whether a loaded file fits an editor's ceiling; a file not loaded as text yet always does. */
function fitsFile(maxBytes: number, loadedBytes: number | null): boolean {
  return loadedBytes === null || loadedBytes <= maxBytes;
}

/** "Edit with…" option labels: the plugin's name, disambiguated when one plugin offers two. */
function pickerOptions(
  candidates: readonly PluginFileEditorCandidate[],
  host: FileEditorPickerOption | null
): FileEditorPickerOption[] {
  const nameCounts = new Map<string, number>();
  for (const candidate of candidates) {
    nameCounts.set(candidate.pluginName, (nameCounts.get(candidate.pluginName) ?? 0) + 1);
  }
  return [
    ...(host ? [host] : []),
    ...candidates.map((candidate) => ({
      value: candidate.choiceId,
      label:
        (nameCounts.get(candidate.pluginName) ?? 0) > 1
          ? `${candidate.pluginName} (${candidate.editor.id})`
          : candidate.pluginName,
    })),
  ];
}

/**
 * Which editor fills Edit and which plugin viewer fills Rendered for one
 * panel's file, and the choices behind them (#13809, #13811).
 */
export function useFileEditorChoice({
  panelId,
  filePath,
  effectiveRootPath,
  pluginEditorsAllowed,
  isRenderable,
  loadedBytes,
  pinnedEditor,
}: {
  panelId: string;
  filePath: string | undefined;
  effectiveRootPath: string;
  /** In the panel (not the dialog), inside a governed root — where Edit is offered too. */
  pluginEditorsAllowed: boolean;
  /** The host renders this type itself, so no plugin may fill Rendered. */
  isRenderable: boolean;
  /** The file's size once it has loaded as text, else null. */
  loadedBytes: number | null;
  /** The editor pinned to the panel: the one a default opened it with, or the one last picked in it. */
  pinnedEditor: string | undefined;
}) {
  // The plugin-contributed editor for this file, resolved enable-aware: a
  // disabled plugin drops Edit live, and the clamp below lands on Source.
  const editor = useFileEditor(filePath);

  // Installed and project plugins' view-backed editors (#13809), from this
  // project view's hosted-view snapshot — a project plugin's only reach its own
  // project. Offered in the panel only, inside a governed root, like Edit.
  // A plugin may fill Rendered only for a type the host can't render itself.
  const pluginEditCandidates = usePluginFileEditorCandidates(
    filePath,
    effectiveRootPath,
    "edit",
    pluginEditorsAllowed
  );
  const pluginViewCandidates = usePluginFileEditorCandidates(
    filePath,
    effectiveRootPath,
    "view",
    pluginEditorsAllowed && !isRenderable
  );
  // The default editor a project plugin set for this file (#13811). Opening
  // with it is `file.openPanel`'s call; the pane asks the user about it.
  const fileDefault = useFileEditorDefault(filePath, effectiveRootPath, pluginEditorsAllowed);
  const initEditorChoices = useFileEditorChoicesStore((s) => s.init);
  useEffect(() => {
    initEditorChoices();
  }, [initEditorChoices]);
  const editorChoicesLoaded = useFileEditorChoicesStore((s) => s.loaded);
  const editorChoices = useFileEditorChoicesStore((s) => s.choices);
  const setEditorChoice = useFileEditorChoicesStore((s) => s.setChoice);
  const builtinEditorName = usePluginRuntimeStore((s) =>
    editor ? (s.pluginMetaById.get(editor.registration.pluginId)?.displayName ?? null) : null
  );

  // Which editor fills each mode. The remembered "Edit with…" answer wins when
  // it is still on offer; otherwise the host's own editor where there is one,
  // so an installed editor adds a choice rather than displacing the built-in.
  // Until the answers have loaded only the built-in may open — a plugin the
  // user has already turned away from must not flash in first. Once the file
  // has loaded, an editor whose ceiling it exceeds is not on offer, so a
  // remembered small editor never hides a capable one.
  //
  // A standing draft pins its owner: the built-in editor and the plugin
  // document controller each keep their own, and handing Edit to the other
  // would hide the draft from the dirty mark and the close prompt. The user
  // saves or discards before switching.
  const draftOwner = useFileDocumentStore((s) => {
    const projection = s.byPanelId[panelId];
    if (!projection?.dirty) return null;
    return isPluginFileDocumentIdentity(projection.identityKey) ? "plugin" : "host";
  });
  const editOptions = useMemo(
    () => [
      ...(editor && draftOwner !== "plugin" && fitsFile(editor.registration.maxBytes, loadedBytes)
        ? [HOST_FILE_EDITOR_CHOICE]
        : []),
      ...(draftOwner === "host"
        ? []
        : pluginEditCandidates
            .filter((candidate) => fitsFile(candidate.editor.maxBytes, loadedBytes))
            .map((candidate) => candidate.choiceId)),
    ],
    [editor, draftOwner, pluginEditCandidates, loadedBytes]
  );
  // An editor pinned to the panel wins while it is on offer, ahead of the
  // answer for the file's type: a default is about these paths, not every file
  // like them.
  const editChoice =
    filePath === undefined
      ? null
      : pinnedEditor !== undefined && editOptions.includes(pinnedEditor)
        ? pinnedEditor
        : editorChoicesLoaded
          ? pickFileEditorChoice(editOptions, editorChoices, fileEditorChoiceKey("edit", filePath))
          : editOptions.includes(HOST_FILE_EDITOR_CHOICE)
            ? HOST_FILE_EDITOR_CHOICE
            : null;
  const builtinEditor = editChoice === HOST_FILE_EDITOR_CHOICE ? editor : null;
  const pluginEditor =
    pluginEditCandidates.find((candidate) => candidate.choiceId === editChoice) ?? null;
  const viewOptions = useMemo(
    () =>
      pluginViewCandidates
        .filter((candidate) => fitsFile(candidate.editor.maxBytes, loadedBytes))
        .map((candidate) => candidate.choiceId),
    [pluginViewCandidates, loadedBytes]
  );
  const viewChoice =
    filePath === undefined || !editorChoicesLoaded
      ? null
      : pickFileEditorChoice(viewOptions, editorChoices, fileEditorChoiceKey("view", filePath));
  const pluginViewer =
    pluginViewCandidates.find((candidate) => candidate.choiceId === viewChoice) ?? null;

  return {
    editor,
    builtinEditorName,
    pluginEditCandidates,
    pluginViewCandidates,
    fileDefault,
    setEditorChoice,
    editOptions,
    editChoice,
    builtinEditor,
    pluginEditor,
    viewOptions,
    viewChoice,
    pluginViewer,
  };
}

export type FileEditorChoice = ReturnType<typeof useFileEditorChoice>;

export interface FileEditorPickerModel {
  label: string;
  choiceKey: ReturnType<typeof fileEditorChoiceKey>;
  value: string;
  options: FileEditorPickerOption[];
}

/**
 * "Edit with…" (#13809): offered in a mode more than one editor can fill,
 * and remembered per project for the file's type.
 */
export function useFileEditorPicker(
  filePath: string | undefined,
  viewMode: FileViewMode,
  showPluginViewer: boolean,
  {
    editOptions,
    editChoice,
    pluginEditCandidates,
    editor,
    builtinEditorName,
    viewOptions,
    viewChoice,
    pluginViewCandidates,
  }: FileEditorChoice
): FileEditorPickerModel | null {
  return useMemo(() => {
    if (filePath === undefined) return null;
    if (viewMode === "edit" && editOptions.length > 1 && editChoice !== null) {
      return {
        label: "Edit with…",
        choiceKey: fileEditorChoiceKey("edit", filePath),
        value: editChoice,
        options: pickerOptions(
          pluginEditCandidates.filter((candidate) => editOptions.includes(candidate.choiceId)),
          editor && editOptions.includes(HOST_FILE_EDITOR_CHOICE)
            ? { value: HOST_FILE_EDITOR_CHOICE, label: builtinEditorName ?? "Built-in editor" }
            : null
        ),
      };
    }
    if (showPluginViewer && viewOptions.length > 1 && viewChoice !== null) {
      return {
        label: "View with…",
        choiceKey: fileEditorChoiceKey("view", filePath),
        value: viewChoice,
        options: pickerOptions(
          pluginViewCandidates.filter((candidate) => viewOptions.includes(candidate.choiceId)),
          null
        ),
      };
    }
    return null;
  }, [
    filePath,
    viewMode,
    editOptions,
    editChoice,
    pluginEditCandidates,
    editor,
    builtinEditorName,
    showPluginViewer,
    viewOptions,
    viewChoice,
    pluginViewCandidates,
  ]);
}
