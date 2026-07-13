// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { AutocompleteItem } from "../../AutocompleteMenu";
import type { ActiveCompletionContext } from "../../hybridInputParsing";
import { useAutocompleteApply } from "../useAutocompleteApply";

type Params = Parameters<typeof useAutocompleteApply>[0];
type Latest = NonNullable<Params["latestRef"]["current"]>;

function setup(doc: string, item: AutocompleteItem, context: ActiveCompletionContext) {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.length } }),
  });
  const applyEditorValue = vi.fn<Params["applyEditorValue"]>();
  const sendText = vi.fn<Params["sendText"]>();
  const setActiveCompletionContext = vi.fn<Params["setActiveCompletionContext"]>();
  const latest: Latest = {
    autocompleteItems: [item],
    selectedIndex: 0,
    activeCompletionContext: context,
  };

  const params: Params = {
    editorViewRef: { current: view },
    latestRef: { current: latest },
    lastQueryRef: { current: "" },
    applyEditorValue,
    sendText,
    setActiveCompletionContext,
    setSelectedIndex: vi.fn(),
  };

  const { result } = renderHook(() => useAutocompleteApply(params));
  return { ...result.current, applyEditorValue, sendText, setActiveCompletionContext, view };
}

const dollarContext: ActiveCompletionContext = {
  triggerChar: "$",
  start: 0,
  tokenEnd: 5,
  query: "plug",
};
const slashContext: ActiveCompletionContext = {
  triggerChar: "/",
  start: 0,
  tokenEnd: 5,
  query: "plug",
};

describe("useAutocompleteApply", () => {
  const capability: AutocompleteItem = {
    key: "plugin-creator",
    label: "Plugin Creator",
    insertText: "$plugin-creator",
    category: "plugin",
    enterAction: "insert",
    insert: "literal",
  };

  const command: AutocompleteItem = {
    key: "commit",
    label: "/commit",
    insertText: "/commit",
    enterAction: "execute",
    insert: "literal",
  };

  it("inserts the canonical token on click, never the display label", () => {
    const { handleAutocompleteSelect, applyEditorValue, sendText, view } = setup(
      "$plug",
      capability,
      dollarContext
    );
    try {
      handleAutocompleteSelect(capability);
      expect(applyEditorValue).toHaveBeenCalledTimes(1);
      expect(applyEditorValue.mock.calls[0]![0]).toBe("$plugin-creator ");
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("a $ capability inserts (not executes) on Enter and closes the menu", () => {
    const {
      applyAutocompleteSelection,
      applyEditorValue,
      sendText,
      setActiveCompletionContext,
      view,
    } = setup("$plug", capability, dollarContext);
    try {
      expect(applyAutocompleteSelection("enter")).toBe(true);
      expect(applyEditorValue).toHaveBeenCalledTimes(1);
      expect(applyEditorValue.mock.calls[0]![0]).toBe("$plugin-creator ");
      expect(sendText).not.toHaveBeenCalled();
      // Menu closes after the first Enter — so the NEXT Enter has no active
      // context and falls through to a normal send (the two-Enter $ flow).
      expect(setActiveCompletionContext).toHaveBeenCalledWith(null);
    } finally {
      view.destroy();
    }
  });

  it("a / command executes on Enter with the canonical token", () => {
    const { applyAutocompleteSelection, applyEditorValue, sendText, view } = setup(
      "/plug",
      command,
      slashContext
    );
    try {
      expect(applyAutocompleteSelection("enter")).toBe(true);
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText.mock.calls[0]![0]).toBe("/commit");
      expect(applyEditorValue).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("Tab/complete always inserts even for an execute item", () => {
    const { applyAutocompleteSelection, applyEditorValue, sendText, view } = setup(
      "/plug",
      command,
      slashContext
    );
    try {
      expect(applyAutocompleteSelection("complete")).toBe(true);
      expect(applyEditorValue).toHaveBeenCalledTimes(1);
      expect(applyEditorValue.mock.calls[0]![0]).toBe("/commit ");
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });
});
