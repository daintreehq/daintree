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

function setup(
  doc: string,
  item: AutocompleteItem,
  context: ActiveCompletionContext,
  selectedIndex = 0
) {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.length } }),
  });
  const applyEditorValue = vi.fn<Params["applyEditorValue"]>();
  const onExecute = vi.fn<Params["onExecute"]>();
  const onPickTemplate = vi.fn<Params["onPickTemplate"]>();
  const setActiveCompletionContext = vi.fn<Params["setActiveCompletionContext"]>();
  const latest: Latest = {
    autocompleteItems: [item],
    selectedIndex,
    activeCompletionContext: context,
  };

  const params: Params = {
    editorViewRef: { current: view },
    latestRef: { current: latest },
    lastQueryRef: { current: "" },
    applyEditorValue,
    onExecute,
    onPickTemplate,
    setActiveCompletionContext,
    setSelectedIndex: vi.fn(),
  };

  const { result } = renderHook(() => useAutocompleteApply(params));
  return {
    ...result.current,
    applyEditorValue,
    onExecute,
    onPickTemplate,
    setActiveCompletionContext,
    view,
  };
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

  it("completes the row it is told to when none is selected, splicing over the `#` token", () => {
    const reference: AutocompleteItem = {
      key: "ref:pr:14843",
      label: "#14843",
      insertText: "#14843",
      enterAction: "insert",
      insert: "literal",
    };
    const hashContext: ActiveCompletionContext = {
      triggerChar: "#",
      start: 4,
      tokenEnd: 8,
      query: "148",
    };
    const { applyAutocompleteSelection, applyEditorValue, view } = setup(
      "see #148",
      reference,
      hashContext,
      -1
    );
    try {
      expect(applyAutocompleteSelection("complete")).toBe(false);
      expect(applyAutocompleteSelection("complete", 0)).toBe(true);
      expect(applyEditorValue.mock.calls[0]![0]).toBe("see #14843 ");
    } finally {
      view.destroy();
    }
  });

  it("inserts the canonical token on click, never the display label", () => {
    const { handleAutocompleteSelect, applyEditorValue, onExecute, view } = setup(
      "$plug",
      capability,
      dollarContext
    );
    try {
      handleAutocompleteSelect(capability);
      expect(applyEditorValue).toHaveBeenCalledTimes(1);
      expect(applyEditorValue.mock.calls[0]![0]).toBe("$plugin-creator ");
      expect(onExecute).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("a $ capability inserts (not executes) on Enter and closes the menu", () => {
    const {
      applyAutocompleteSelection,
      applyEditorValue,
      onExecute,
      setActiveCompletionContext,
      view,
    } = setup("$plug", capability, dollarContext);
    try {
      expect(applyAutocompleteSelection("enter")).toBe(true);
      expect(applyEditorValue).toHaveBeenCalledTimes(1);
      expect(applyEditorValue.mock.calls[0]![0]).toBe("$plugin-creator ");
      expect(onExecute).not.toHaveBeenCalled();
      // Menu closes after the first Enter — so the NEXT Enter has no active
      // context and falls through to a normal send (the two-Enter $ flow).
      expect(setActiveCompletionContext).toHaveBeenCalledWith(null);
    } finally {
      view.destroy();
    }
  });

  it("a / command executes on Enter with the canonical token", () => {
    const { applyAutocompleteSelection, applyEditorValue, onExecute, view } = setup(
      "/plug",
      command,
      slashContext
    );
    try {
      expect(applyAutocompleteSelection("enter")).toBe(true);
      expect(onExecute).toHaveBeenCalledTimes(1);
      expect(onExecute.mock.calls[0]![0]).toBe("/commit");
      expect(applyEditorValue).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("Tab/complete always inserts even for an execute item", () => {
    const { applyAutocompleteSelection, applyEditorValue, onExecute, view } = setup(
      "/plug",
      command,
      slashContext
    );
    try {
      expect(applyAutocompleteSelection("complete")).toBe(true);
      expect(applyEditorValue).toHaveBeenCalledTimes(1);
      expect(applyEditorValue.mock.calls[0]![0]).toBe("/commit ");
      expect(onExecute).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  describe("a prompt template row", () => {
    const template: AutocompleteItem = {
      key: "template:acme::boilerplate",
      label: "Add boilerplate",
      insertText: "",
      group: "Prompt templates",
      template: { key: "acme::boilerplate", opensForm: false },
    };
    const midDraft: ActiveCompletionContext = {
      triggerChar: "/",
      start: 4,
      tokenEnd: 9,
      query: "boil",
    };

    it.each([
      ["Enter", "enter"],
      ["Tab", "complete"],
    ] as const)("hands %s to the host with the token it was picked with", (_key, mode) => {
      const {
        applyAutocompleteSelection,
        applyEditorValue,
        onExecute,
        onPickTemplate,
        setActiveCompletionContext,
        view,
      } = setup("Fix /boil", template, midDraft);
      try {
        expect(applyAutocompleteSelection(mode)).toBe(true);
        expect(onPickTemplate).toHaveBeenCalledWith("acme::boilerplate", { from: 4, to: 9 });
        expect(applyEditorValue).not.toHaveBeenCalled();
        expect(onExecute).not.toHaveBeenCalled();
        expect(setActiveCompletionContext).toHaveBeenCalledWith(null);
      } finally {
        view.destroy();
      }
    });

    it("hands a click to the host and types nothing", () => {
      const { handleAutocompleteSelect, applyEditorValue, onPickTemplate, view } = setup(
        "/boil",
        template,
        { ...slashContext, tokenEnd: 5 }
      );
      try {
        handleAutocompleteSelect(template);
        expect(onPickTemplate).toHaveBeenCalledWith("acme::boilerplate", { from: 0, to: 5 });
        expect(applyEditorValue).not.toHaveBeenCalled();
      } finally {
        view.destroy();
      }
    });

    it("does nothing when the token it was picked from is gone", () => {
      const { applyAutocompleteSelection, onPickTemplate, view } = setup(
        "Fix it",
        template,
        midDraft
      );
      try {
        applyAutocompleteSelection("enter");
        expect(onPickTemplate).not.toHaveBeenCalled();
      } finally {
        view.destroy();
      }
    });
  });
});
