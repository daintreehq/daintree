// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { AutocompleteItem } from "../../AutocompleteMenu";
import { useAutocompleteApply } from "../useAutocompleteApply";

type Params = Parameters<typeof useAutocompleteApply>[0];
type Latest = NonNullable<Params["latestRef"]["current"]>;

function makeView(doc: string, caret = doc.length) {
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: caret } }),
  });
}

function setup(doc: string, item: AutocompleteItem) {
  const view = makeView(doc);
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
  return { ...result.current, applyEditorValue, sendText };
}

describe("useAutocompleteApply", () => {
  const item: AutocompleteItem = {
    key: "plugin-creator",
    label: "Plugin Creator",
    insertText: "$plugin-creator",
    category: "plugin",
  };

  it("inserts the canonical token, never the display label", () => {
    const { handleAutocompleteSelect, applyEditorValue } = setup("/plug", item);

    handleAutocompleteSelect(item);

    expect(applyEditorValue).toHaveBeenCalledTimes(1);
    const inserted = applyEditorValue.mock.calls[0]![0];
    expect(inserted).toContain("$plugin-creator");
    expect(inserted).not.toContain("Plugin Creator");
  });

  it("executes with the canonical token, never the display label", () => {
    const { applyAutocompleteSelection, sendText } = setup("/plug", item);

    expect(applyAutocompleteSelection("execute")).toBe(true);

    expect(sendText).toHaveBeenCalledTimes(1);
    const sent = sendText.mock.calls[0]![0];
    expect(sent).toContain("$plugin-creator");
    expect(sent).not.toContain("Plugin Creator");
  });
});
