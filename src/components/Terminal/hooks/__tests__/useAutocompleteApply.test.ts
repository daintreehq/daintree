// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { AutocompleteItem } from "../../AutocompleteMenu";
import { useAutocompleteApply } from "../useAutocompleteApply";

type Params = Parameters<typeof useAutocompleteApply>[0];
type Latest = NonNullable<Params["latestRef"]["current"]>;

function setup(doc: string, item: AutocompleteItem) {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.length } }),
  });
  const applyEditorValue = vi.fn<Params["applyEditorValue"]>();
  const sendText = vi.fn<Params["sendText"]>();
  const latest: Latest = {
    activeMode: "command",
    autocompleteItems: [item],
    selectedIndex: 0,
    slashContext: null,
    atContext: null,
    diffContext: null,
    terminalContext: null,
    selectionContext: null,
  };

  const params: Params = {
    editorViewRef: { current: view },
    latestRef: { current: latest },
    lastQueryRef: { current: "" },
    applyEditorValue,
    sendText,
    setAtContext: vi.fn(),
    setSlashContext: vi.fn(),
    setDiffContext: vi.fn(),
    setTerminalContext: vi.fn(),
    setSelectionContext: vi.fn(),
    setSelectedIndex: vi.fn(),
  };

  const { result } = renderHook(() => useAutocompleteApply(params));
  return { ...result.current, applyEditorValue, sendText, view };
}

describe("useAutocompleteApply", () => {
  const item: AutocompleteItem = {
    key: "plugin-creator",
    label: "Plugin Creator",
    insertText: "$plugin-creator",
    category: "plugin",
  };

  it("inserts the canonical token, never the display label", () => {
    const { handleAutocompleteSelect, applyEditorValue, sendText, view } = setup("/plug", item);
    try {
      handleAutocompleteSelect(item);

      expect(applyEditorValue).toHaveBeenCalledTimes(1);
      // Replaces the whole "/plug" slash token with the canonical insert token.
      expect(applyEditorValue.mock.calls[0]![0]).toBe("$plugin-creator ");
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("executes with the canonical token, never the display label", () => {
    const { applyAutocompleteSelection, applyEditorValue, sendText, view } = setup("/plug", item);
    try {
      expect(applyAutocompleteSelection("execute")).toBe(true);

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText.mock.calls[0]![0]).toBe("$plugin-creator");
      expect(applyEditorValue).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });
});
