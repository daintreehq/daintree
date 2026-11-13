import { useLayoutEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type { Compartment } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { ITheme } from "@xterm/xterm";
import {
  buildInputBarTheme,
  chipEntranceTheme,
  createContentAttributes,
  createComboboxAttributes,
  createPlaceholder,
  createSlashChipField,
  createSlashTooltip,
  createFileChipField,
  createFileChipTooltip,
  imageChipField,
  createImageChipTooltip,
  fileDropChipField,
  createFileDropChipTooltip,
  diffChipField,
  createDiffChipTooltip,
  notesChipField,
  createNotesChipTooltip,
  terminalChipField,
  createTerminalChipTooltip,
  selectionChipField,
  createSelectionChipTooltip,
  contextReferenceChipField,
  createContextReferenceChipTooltip,
  forgeReferenceField,
  createForgeReferenceTooltip,
  interimWidgetField,
  dictationFollow,
  voiceCaret,
  createCaretTracker,
  completionBoundary,
  pendingAIField,
  pendingLock,
  voiceRewriteTracker,
  createAutoSize,
  createCustomKeymap,
  chipPendingDeleteField,
  createChipBackspaceKeymap,
  createCursorBlink,
  createComposerHistory,
  createCorrectionReview,
  type AutoSizeConfig,
} from "../inputEditorExtensions";
import type { SlashCommand } from "@shared/types";
import {
  announceCorrectionShown,
  rebaseCorrectionBaseline,
} from "@/services/voiceCorrectionLanding";
import { recordComposerBindings } from "../inputEditorExtensions/composerBindings";
import {
  keepComposerRemount,
  restoreComposerRemount,
} from "../inputEditorExtensions/composerRemount";
import { takeComposerSnapshot } from "@/lib/composerRemount";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { recordBuiltCompartmentConfig } from "./useCompartmentDriver";

interface UseEditorFactoryParams {
  terminalId: string;
  /** Where dictation into this composer is kept, for its correction review. */
  voiceId: string;
  /** The draft key (`makeDraftKey`) of the draft this composer edits. */
  draftKeyRef: React.RefObject<string>;
  editorHostRef: React.RefObject<HTMLDivElement | null>;
  editorViewRef: React.RefObject<EditorView | null>;
  disabled: boolean;
  placeholder: string;
  effectiveTheme: ITheme;
  commandMap: Map<string, SlashCommand>;
  compartments: {
    themeCompartmentRef: React.RefObject<Compartment>;
    placeholderCompartmentRef: React.RefObject<Compartment>;
    editableCompartmentRef: React.RefObject<Compartment>;
    chipCompartmentRef: React.RefObject<Compartment>;
    tooltipCompartmentRef: React.RefObject<Compartment>;
    fileChipTooltipCompartmentRef: React.RefObject<Compartment>;
    imageChipTooltipCompartmentRef: React.RefObject<Compartment>;
    fileDropChipTooltipCompartmentRef: React.RefObject<Compartment>;
    diffChipTooltipCompartmentRef: React.RefObject<Compartment>;
    terminalChipTooltipCompartmentRef: React.RefObject<Compartment>;
    selectionChipTooltipCompartmentRef: React.RefObject<Compartment>;
    contextChipTooltipCompartmentRef: React.RefObject<Compartment>;
    notesChipTooltipCompartmentRef: React.RefObject<Compartment>;
    forgeReferenceTooltipCompartmentRef: React.RefObject<Compartment>;
    autoSizeCompartmentRef: React.RefObject<Compartment>;
    keymapCompartmentRef: React.RefObject<Compartment>;
    comboboxCompartmentRef: React.RefObject<Compartment>;
  };
  contextUpdateRef: React.RefObject<(update: import("@codemirror/view").ViewUpdate) => void>;
  keymapHandlersRef: React.RefObject<{
    onEnter: () => boolean;
    onModEnter: () => boolean;
    onEscape: () => boolean;
    onArrowUp: () => boolean;
    onArrowDown: () => boolean;
    onArrowLeft: () => boolean;
    onArrowRight: () => boolean;
    onTab: () => boolean;
    onCtrlC: (hasSelection: boolean) => boolean;
    onStash: () => boolean;
    onPopStash: () => boolean;
    onExpand: () => boolean;
    onHistorySearch: () => boolean;
  } | null>;
  domEventHandlers: Extension;
  imagePasteExtension: Extension;
  filePasteExtension: Extension;
  plainPasteKeymap: Extension;
  autoSizeConfig?: AutoSizeConfig;
}

export function useEditorFactory({
  terminalId,
  voiceId,
  draftKeyRef,
  editorHostRef,
  editorViewRef,
  disabled,
  placeholder,
  effectiveTheme,
  commandMap,
  compartments,
  contextUpdateRef,
  keymapHandlersRef,
  domEventHandlers,
  imagePasteExtension,
  filePasteExtension,
  plainPasteKeymap,
}: UseEditorFactoryParams) {
  // Read when a review swaps, not when the editor was built.
  const voiceIdRef = useRef(voiceId);
  useLayoutEffect(() => {
    voiceIdRef.current = voiceId;
  }, [voiceId]);

  useLayoutEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;
    if (editorViewRef.current) return;

    // The draft this editor shows for as long as it lives. A tab switch builds
    // another editor in the same composer, so the draft is read now, not kept
    // from its first render, and what this one held is kept for its own draft.
    const draftKey = draftKeyRef.current;
    const readDraft = () => useTerminalInputStore.getState().draftInputs.get(draftKey) ?? "";
    const doc = readDraft();
    const kept = takeComposerSnapshot(draftKey, doc);

    const {
      themeCompartmentRef,
      placeholderCompartmentRef,
      editableCompartmentRef,
      chipCompartmentRef,
      tooltipCompartmentRef,
      fileChipTooltipCompartmentRef,
      imageChipTooltipCompartmentRef,
      fileDropChipTooltipCompartmentRef,
      diffChipTooltipCompartmentRef,
      terminalChipTooltipCompartmentRef,
      selectionChipTooltipCompartmentRef,
      contextChipTooltipCompartmentRef,
      notesChipTooltipCompartmentRef,
      forgeReferenceTooltipCompartmentRef,
      autoSizeCompartmentRef,
      keymapCompartmentRef,
      comboboxCompartmentRef,
    } = compartments;

    const extensions: Extension[] = [
      chipPendingDeleteField,
      createChipBackspaceKeymap(),
      createComposerHistory(),
      themeCompartmentRef.current.of(buildInputBarTheme(effectiveTheme)),
      chipEntranceTheme,
      EditorView.lineWrapping,
      createCursorBlink(),
      createContentAttributes(),
      comboboxCompartmentRef.current.of(createComboboxAttributes(null)),
      autoSizeCompartmentRef.current.of(createAutoSize()),
      placeholderCompartmentRef.current.of(createPlaceholder(placeholder)),
      editableCompartmentRef.current.of(EditorView.editable.of(!disabled)),
      chipCompartmentRef.current.of(createSlashChipField({ commandMap })),
      tooltipCompartmentRef.current.of(!disabled ? createSlashTooltip(commandMap) : []),
      createFileChipField(),
      fileChipTooltipCompartmentRef.current.of(!disabled ? createFileChipTooltip() : []),
      imageChipField,
      imageChipTooltipCompartmentRef.current.of(!disabled ? createImageChipTooltip() : []),
      fileDropChipField,
      fileDropChipTooltipCompartmentRef.current.of(!disabled ? createFileDropChipTooltip() : []),
      diffChipField,
      diffChipTooltipCompartmentRef.current.of(!disabled ? createDiffChipTooltip() : []),
      terminalChipField,
      terminalChipTooltipCompartmentRef.current.of(!disabled ? createTerminalChipTooltip() : []),
      selectionChipField,
      selectionChipTooltipCompartmentRef.current.of(!disabled ? createSelectionChipTooltip() : []),
      contextReferenceChipField,
      contextChipTooltipCompartmentRef.current.of(
        !disabled ? createContextReferenceChipTooltip() : []
      ),
      notesChipField,
      notesChipTooltipCompartmentRef.current.of(!disabled ? createNotesChipTooltip() : []),
      forgeReferenceField,
      forgeReferenceTooltipCompartmentRef.current.of(
        !disabled ? createForgeReferenceTooltip() : []
      ),
      interimWidgetField,
      dictationFollow,
      voiceCaret,
      createCaretTracker(() => draftKeyRef.current, kept?.caretPublished === true),
      completionBoundary,
      pendingAIField,
      pendingLock,
      voiceRewriteTracker,
      createCorrectionReview({
        onShown: announceCorrectionShown,
        onSwapped: (review, now) => rebaseCorrectionBaseline(voiceIdRef.current, review, now),
      }),
      EditorView.updateListener.of((update) => contextUpdateRef.current(update)),
      keymapCompartmentRef.current.of(
        createCustomKeymap({
          onEnter: () => keymapHandlersRef.current?.onEnter() ?? false,
          onModEnter: () => keymapHandlersRef.current?.onModEnter() ?? false,
          onEscape: () => keymapHandlersRef.current?.onEscape() ?? false,
          onArrowUp: () => keymapHandlersRef.current?.onArrowUp() ?? false,
          onArrowDown: () => keymapHandlersRef.current?.onArrowDown() ?? false,
          onArrowLeft: () => keymapHandlersRef.current?.onArrowLeft() ?? false,
          onArrowRight: () => keymapHandlersRef.current?.onArrowRight() ?? false,
          onTab: () => keymapHandlersRef.current?.onTab() ?? false,
          onCtrlC: (hasSelection: boolean) =>
            keymapHandlersRef.current?.onCtrlC(hasSelection) ?? false,
          onStash: () => keymapHandlersRef.current?.onStash() ?? false,
          onPopStash: () => keymapHandlersRef.current?.onPopStash() ?? false,
          onExpand: () => keymapHandlersRef.current?.onExpand() ?? false,
          onHistorySearch: () => keymapHandlersRef.current?.onHistorySearch() ?? false,
        })
      ),
      domEventHandlers,
      imagePasteExtension,
      filePasteExtension,
      plainPasteKeymap,
    ];
    const created = EditorState.create({ doc, extensions });
    const state = kept ? restoreComposerRemount(created, kept) : created;

    const view = new EditorView({ state, parent: host });
    editorViewRef.current = view;
    recordComposerBindings(view, {
      extensions,
      compartments: Object.values(compartments).map((ref) => ref.current),
    });
    // Chip tooltips above are gated on `disabled` only, i.e. built as if
    // autocomplete were closed.
    recordBuiltCompartmentConfig(view, {
      effectiveTheme,
      placeholder,
      disabled,
      commandMap,
      isAutocompleteOpen: false,
    });

    return () => {
      // A panel closed to the trash keeps its draft for an undone close, but
      // not what its composer held: the close lets that go.
      if (usePanelStore.getState().panelsById[terminalId]?.location !== "trash") {
        keepComposerRemount(view, draftKey, readDraft());
      }
      view.destroy();
      editorViewRef.current = null;
    };
  }, [terminalId]);
}
