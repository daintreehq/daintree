import { useLayoutEffect, useRef } from "react";
import { EditorView, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type { Compartment } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { ITheme } from "@xterm/xterm";
import {
  buildInputBarTheme,
  chipEntranceTheme,
  createContentAttributes,
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
  terminalChipField,
  createTerminalChipTooltip,
  selectionChipField,
  createSelectionChipTooltip,
  interimWidgetField,
  pendingAIField,
  createAutoSize,
  createCustomKeymap,
  chipPendingDeleteField,
  createChipBackspaceKeymap,
  type AutoSizeConfig,
} from "../inputEditorExtensions";
import type { SlashCommand } from "@shared/types";

interface UseEditorFactoryParams {
  terminalId: string;
  editorHostRef: React.RefObject<HTMLDivElement | null>;
  editorViewRef: React.RefObject<EditorView | null>;
  value: string;
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
    autoSizeCompartmentRef: React.RefObject<Compartment>;
    keymapCompartmentRef: React.RefObject<Compartment>;
  };
  contextUpdateRef: React.RefObject<(update: import("@codemirror/view").ViewUpdate) => void>;
  keymapHandlersRef: React.RefObject<{
    onEnter: () => boolean;
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
  editorHostRef,
  editorViewRef,
  value,
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
  const initialValueRef = useRef(value);

  useLayoutEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;
    if (editorViewRef.current) return;

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
      autoSizeCompartmentRef,
      keymapCompartmentRef,
    } = compartments;

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        chipPendingDeleteField,
        createChipBackspaceKeymap(),
        themeCompartmentRef.current.of(buildInputBarTheme(effectiveTheme)),
        chipEntranceTheme,
        EditorView.lineWrapping,
        drawSelection(),
        createContentAttributes(),
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
        selectionChipTooltipCompartmentRef.current.of(
          !disabled ? createSelectionChipTooltip() : []
        ),
        interimWidgetField,
        pendingAIField,
        EditorView.updateListener.of((update) => contextUpdateRef.current(update)),
        keymapCompartmentRef.current.of(
          createCustomKeymap({
            onEnter: () => keymapHandlersRef.current?.onEnter() ?? false,
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
      ],
    });

    const view = new EditorView({ state, parent: host });
    editorViewRef.current = view;

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  }, [terminalId]);
}
