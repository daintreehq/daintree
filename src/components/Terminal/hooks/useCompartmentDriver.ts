import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { EditorView as EditorViewFacet } from "@codemirror/view";
import type { Compartment, Extension, StateEffect } from "@codemirror/state";
import {
  buildInputBarTheme,
  createPlaceholder,
  createSlashChipField,
  createSlashTooltip,
  createFileChipTooltip,
  createImageChipTooltip,
  createFileDropChipTooltip,
  createDiffChipTooltip,
  createTerminalChipTooltip,
  createSelectionChipTooltip,
} from "../inputEditorExtensions";
import type { SlashCommand } from "@shared/types";

export interface CompartmentConfig {
  effectiveTheme: import("@xterm/xterm").ITheme;
  placeholder: string;
  disabled: boolean;
  commandMap: Map<string, SlashCommand>;
  isAutocompleteOpen: boolean;
}

// The config each view's compartments were last built or reconfigured from.
// useEditorFactory records what it built, so the driver's first run after a
// view is created (mount, StrictMode replay, terminalId change) diffs against
// that instead of rebuilding every compartment.
const appliedConfigs = new WeakMap<EditorView, CompartmentConfig>();

export function recordBuiltCompartmentConfig(view: EditorView, config: CompartmentConfig): void {
  appliedConfigs.set(view, config);
}

interface UseCompartmentDriverParams {
  editorViewRef: React.RefObject<EditorView | null>;
  themeCompartmentRef: React.RefObject<Compartment>;
  effectiveTheme: import("@xterm/xterm").ITheme;
  placeholderCompartmentRef: React.RefObject<Compartment>;
  placeholder: string;
  editableCompartmentRef: React.RefObject<Compartment>;
  disabled: boolean;
  chipCompartmentRef: React.RefObject<Compartment>;
  commandMap: Map<string, SlashCommand>;
  tooltipCompartmentRef: React.RefObject<Compartment>;
  fileChipTooltipCompartmentRef: React.RefObject<Compartment>;
  imageChipTooltipCompartmentRef: React.RefObject<Compartment>;
  fileDropChipTooltipCompartmentRef: React.RefObject<Compartment>;
  diffChipTooltipCompartmentRef: React.RefObject<Compartment>;
  terminalChipTooltipCompartmentRef: React.RefObject<Compartment>;
  selectionChipTooltipCompartmentRef: React.RefObject<Compartment>;
  isAutocompleteOpen: boolean;
}

export function useCompartmentDriver({
  editorViewRef,
  themeCompartmentRef,
  effectiveTheme,
  placeholderCompartmentRef,
  placeholder,
  editableCompartmentRef,
  disabled,
  chipCompartmentRef,
  commandMap,
  tooltipCompartmentRef,
  fileChipTooltipCompartmentRef,
  imageChipTooltipCompartmentRef,
  fileDropChipTooltipCompartmentRef,
  diffChipTooltipCompartmentRef,
  terminalChipTooltipCompartmentRef,
  selectionChipTooltipCompartmentRef,
  isAutocompleteOpen,
}: UseCompartmentDriverParams) {
  // Each compartment is reconfigured on exactly the prop changes its own
  // effect used to depend on, but all of them land in a single transaction.
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const prev = appliedConfigs.get(view);
    appliedConfigs.set(view, {
      effectiveTheme,
      placeholder,
      disabled,
      commandMap,
      isAutocompleteOpen,
    });
    const changed = <K extends keyof CompartmentConfig>(key: K, next: CompartmentConfig[K]) =>
      !prev || prev[key] !== next;
    const themeChanged = changed("effectiveTheme", effectiveTheme);
    const placeholderChanged = changed("placeholder", placeholder);
    const disabledChanged = changed("disabled", disabled);
    const commandMapChanged = changed("commandMap", commandMap);
    const autocompleteChanged = changed("isAutocompleteOpen", isAutocompleteOpen);
    const tooltipsSuppressed = disabled || isAutocompleteOpen;

    const effects: StateEffect<unknown>[] = [];
    if (themeChanged) {
      effects.push(themeCompartmentRef.current.reconfigure(buildInputBarTheme(effectiveTheme)));
    }
    if (placeholderChanged) {
      effects.push(placeholderCompartmentRef.current.reconfigure(createPlaceholder(placeholder)));
    }
    if (disabledChanged) {
      effects.push(
        editableCompartmentRef.current.reconfigure(EditorViewFacet.editable.of(!disabled))
      );
    }
    if (commandMapChanged) {
      effects.push(chipCompartmentRef.current.reconfigure(createSlashChipField({ commandMap })));
    }
    const tooltipGateChanged = disabledChanged || autocompleteChanged;
    if (tooltipGateChanged || commandMapChanged) {
      effects.push(
        tooltipCompartmentRef.current.reconfigure(
          tooltipsSuppressed ? [] : createSlashTooltip(commandMap)
        )
      );
    }
    if (tooltipGateChanged) {
      const chipTooltips: Array<[React.RefObject<Compartment>, () => Extension]> = [
        [fileChipTooltipCompartmentRef, createFileChipTooltip],
        [imageChipTooltipCompartmentRef, createImageChipTooltip],
        [fileDropChipTooltipCompartmentRef, createFileDropChipTooltip],
        [diffChipTooltipCompartmentRef, createDiffChipTooltip],
        [terminalChipTooltipCompartmentRef, createTerminalChipTooltip],
        [selectionChipTooltipCompartmentRef, createSelectionChipTooltip],
      ];
      for (const [ref, create] of chipTooltips) {
        effects.push(ref.current.reconfigure(tooltipsSuppressed ? [] : create()));
      }
    }
    if (effects.length > 0) view.dispatch({ effects });
  }, [
    editorViewRef,
    effectiveTheme,
    placeholder,
    disabled,
    commandMap,
    isAutocompleteOpen,
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
  ]);
}
