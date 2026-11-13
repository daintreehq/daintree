// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import type { PtyPanelData } from "@shared/types/panel";
import { getBuiltinSlashCommands } from "@shared/types";
import type { PromptTemplateArgument, PromptTemplateContribution } from "@shared/types/plugin";
import type { UserPromptTemplatesSnapshot } from "@shared/types/ipc/userPromptTemplates";
import type { PluginPromptTemplate } from "@/store/pluginRuntimeStore";

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import {
  subscribeDictationRangeTracking,
  useDictationRangeStore,
} from "@/store/dictationRangeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import {
  _resetUserPromptTemplateStoreForTest,
  useUserPromptTemplateStore,
} from "@/store/userPromptTemplateStore";
import { actionService } from "@/services/ActionService";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { toSlashAutocompleteItems } from "@/hooks/slashAutocompleteItems";
import { HybridInputBar } from "../HybridInputBar";
import { PROMPT_TEMPLATE_BAND } from "../promptTemplateCompletion";

// CodeMirror measures text through Range rects on an animation frame, which
// can land after a test ends; jsdom has neither method.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
});

const WT_ID = "/repo/wt";
const TERMINAL_ID = "term-1";

function entry(
  body: string,
  args: { name: string; label: string; required?: boolean }[] = []
): PluginPromptTemplate {
  return {
    key: "acme::boilerplate",
    pluginId: "acme",
    pluginName: "Acme CRM",
    projectId: null,
    template: {
      id: "boilerplate",
      title: "Add boilerplate",
      description: "Standard closing instructions.",
      body,
      args,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: {} },
  });
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  useTerminalInputStore.setState({ draftInputs: new Map() });
  usePluginRuntimeStore.setState({ promptTemplates: [] });
  _resetUserPromptTemplateStoreForTest();
  useProjectStore.setState({ currentProject: null });
  const panel = {
    id: TERMINAL_ID,
    title: "claude",
    kind: "terminal",
    cwd: WT_ID,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    runtimeStatus: "running",
  } as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
    panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
    focusedId: panel.id,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderComposer(draft: string, templates: PluginPromptTemplate[] = []) {
  usePluginRuntimeStore.setState({ promptTemplates: templates });
  const onSend = vi.fn();
  const { container } = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId={TERMINAL_ID} cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const content = container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  view.contentDOM.focus();
  if (draft) {
    act(() => {
      view.dispatch({ changes: { from: 0, insert: draft } });
    });
  }

  // Types at the end of the draft, the caret after it, as a keystroke would.
  const type = async (text: string) => {
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        selection: { anchor: view.state.doc.length + text.length },
        userEvent: "input.type",
      });
    });
  };
  const press = async (key: string) => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");
    });
  };
  const rows = () =>
    screen
      .queryAllByRole("option")
      .filter((option) => option.getAttribute("aria-disabled") !== "true")
      .map((option) => option.textContent ?? "");
  // The token each row is listed under, read from the row's first line.
  const labels = () =>
    screen
      .queryAllByRole("option")
      .filter((option) => option.getAttribute("aria-disabled") !== "true")
      .map((option) => option.querySelector("span")?.textContent ?? "");
  const bands = () =>
    screen
      .queryAllByRole("option")
      .filter((option) => option.getAttribute("aria-disabled") === "true")
      .map((option) => option.getAttribute("aria-label"));
  return { container, onSend, view, type, press, rows, labels, bands };
}

const storedDraft = () => useTerminalInputStore.getState().getDraftInput(TERMINAL_ID);

// CodeMirror groups undo steps made within 500ms of each other, so an edit
// that should stand alone only proves it does when the next one comes inside
// that window, however slowly the run goes.
const pinHistoryClock = () => vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

// A template is added to what the user has written, never put in its place
// (#14956), and never sent (#13799). It is picked from the `/` menu (#15309).
describe("HybridInputBar prompt templates in the `/` menu", () => {
  it("lists templates after the agent's commands, in a band of their own", async () => {
    const { type, rows, bands } = await renderComposer("", [entry("Run the tests.")]);

    await type("/");

    const all = rows();
    expect(all.length).toBeGreaterThan(1);
    expect(all.at(-1)).toContain("Add boilerplate");
    expect(all.at(-1)).toContain("Acme CRM");
    expect(all.slice(0, -1).some((row) => row.includes("Add boilerplate"))).toBe(false);
    expect(bands()).toEqual([PROMPT_TEMPLATE_BAND]);
  });

  it("leaves the `/` menu as it was when no plugin offers a template", async () => {
    const { type, labels, bands } = await renderComposer("");

    await type("/");

    const expected = toSlashAutocompleteItems(getBuiltinSlashCommands("claude"), "").map(
      (item) => item.label
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(labels()).toEqual(expected);
    expect(bands()).toEqual([]);
  });

  it("drops the band once the query matches no template", async () => {
    const { type, rows, bands } = await renderComposer("", [entry("Run the tests.")]);

    await type("/boiler");
    expect(rows()).toHaveLength(1);
    expect(bands()).toEqual([PROMPT_TEMPLATE_BAND]);

    await type("x");
    expect(rows().some((row) => row.includes("Add boilerplate"))).toBe(false);
    expect(bands()).toEqual([]);
  });

  it.each([["Enter"], ["Tab"]])(
    "fills an empty draft on %s, taking out the `/` token, and sends nothing",
    async (key) => {
      const { view, type, press, onSend } = await renderComposer("", [entry("Run the tests.")]);

      await type("/boiler");
      await press(key);

      expect(view.state.doc.toString()).toBe("Run the tests.");
      expect(view.state.selection.main.head).toBe("Run the tests.".length);
      expect(storedDraft()).toBe("Run the tests.");
      expect(onSend).not.toHaveBeenCalled();
    }
  );

  it("adds the template a blank line after what is already written, on a click", async () => {
    const { view, type, onSend } = await renderComposer("Fix the retry loop.", [
      entry("Run the tests."),
    ]);

    await type(" /boiler");
    fireEvent.click(screen.getByRole("option", { name: /Add boilerplate/ }));
    await act(async () => {});

    const expected = "Fix the retry loop.\n\nRun the tests.";
    expect(view.state.doc.toString()).toBe(expected);
    expect(view.state.selection.main.head).toBe(expected.length);
    expect(storedDraft()).toBe(expected);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("adds only the newlines the draft is missing", async () => {
    const { view, type, press } = await renderComposer("Fix the retry loop.\n", [
      entry("Run the tests."),
    ]);

    await type("/boiler");
    await press("Enter");

    expect(view.state.doc.toString()).toBe("Fix the retry loop.\n\nRun the tests.");
  });

  it("takes a token typed inside the draft out with the space after it", async () => {
    const { view, press } = await renderComposer("Fix the loop", [entry("Run the tests.")]);
    await act(async () => {
      view.dispatch({
        changes: { from: 4, insert: "/boiler " },
        selection: { anchor: 4 + "/boiler".length },
        userEvent: "input.type",
      });
    });

    await press("Enter");

    expect(view.state.doc.toString()).toBe("Fix the loop\n\nRun the tests.");
  });

  it.each([
    ["fills in", entry("Run the tests."), "Fix it\n\nRun the tests."],
    [
      "opens a form for",
      entry("Tell {{who}} when done.", [{ name: "who", label: "Who" }]),
      "Fix it",
    ],
  ])(
    "keeps a dictated passage the token was typed against, unedited, when it %s a template (#15872)",
    async (_what, template, expected) => {
      const stop = subscribeDictationRangeTracking();
      try {
        useDictationRangeStore.setState({ drafts: {}, anchors: {} });
        const passage = "Fix it";
        useDictationRangeStore.getState().expectDraftChange(TERMINAL_ID, undefined, "", passage, {
          from: 0,
          to: 0,
          insert: passage,
        });
        useTerminalInputStore.getState().setDraftInput(TERMINAL_ID, passage);
        useDictationRangeStore
          .getState()
          .recordUtterance(
            { sessionId: "s1", panelId: TERMINAL_ID },
            { insertion: { from: 0, to: passage.length }, words: { from: 0, to: passage.length } }
          );
        const { view, press } = await renderComposer("", [template]);
        act(() => {
          view.dispatch({ selection: { anchor: 0 } });
        });
        for (const char of "/boiler") {
          await act(async () => {
            const at = view.state.selection.main.head;
            view.dispatch({
              changes: { from: at, insert: char },
              selection: { anchor: at + 1 },
              userEvent: "input.type",
            });
          });
        }
        expect(view.state.doc.toString()).toBe(`/boiler${passage}`);

        await press("Enter");

        expect(view.state.doc.toString()).toBe(expected);
        const [record] = useDictationRangeStore.getState().listDictations(TERMINAL_ID);
        expect(record!.range.edited).toBe(false);
        expect(storedDraft().slice(record!.range.from, record!.range.to)).toBe(passage);
      } finally {
        stop();
      }
    }
  );

  it("replaces a draft that is only whitespace", async () => {
    const { view, type, press } = await renderComposer("  \n", [entry("Run the tests.")]);

    await type("/boiler");
    await press("Enter");

    expect(view.state.doc.toString()).toBe("Run the tests.");
    expect(storedDraft()).toBe("Run the tests.");
  });

  it("takes the pick back in one undo step, apart from typing after it", async () => {
    const { view, type, press } = await renderComposer("Fix the retry loop.", [
      entry("Run the tests."),
    ]);

    await type(" /boiler");
    await press("Enter");
    act(() => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "!" },
        userEvent: "input.type",
      });
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop.\n\nRun the tests.!");

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop.\n\nRun the tests.");

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop. /boiler");
  });

  it("keeps a pick made straight after typing its token apart from that typing in undo", async () => {
    const { view, type, press } = await renderComposer("", [entry("Run the tests.")]);

    await type("/boiler");
    await press("Enter");
    await type("!");
    expect(view.state.doc.toString()).toBe("Run the tests.!");

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Run the tests.");

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("/boiler");
  });

  it("lands a template written with CRLF breaks, with the caret after it", async () => {
    const { view, type, press } = await renderComposer("Fix the retry loop.", [
      entry("Run:\r\n- tests\r- lint"),
    ]);

    await type(" /boiler");
    await press("Enter");

    const expected = "Fix the retry loop.\n\nRun:\n- tests\n- lint";
    expect(view.state.doc.toString()).toBe(expected);
    expect(view.state.selection.main.head).toBe(expected.length);
  });

  it("opens the form for a template that asks for arguments, and fills the draft as it stands", async () => {
    const { view, type, press, onSend } = await renderComposer("Fix the retry loop.", [
      entry("Tell {{who}} when done.", [{ name: "who", label: "Who", required: true }]),
    ]);

    await type(" /boiler");
    await press("Enter");

    // The token is spent the moment the form has the pick.
    expect(view.state.doc.toString()).toBe("Fix the retry loop.");
    fireEvent.change(await screen.findByLabelText("Who"), { target: { value: "Ada" } });
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: " Keep the API." } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Fill draft" }));
    await act(async () => {});

    expect(view.state.doc.toString()).toBe(
      "Fix the retry loop. Keep the API.\n\nTell Ada when done."
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the token it took for a form as its own undo step when the form is cancelled", async () => {
    pinHistoryClock();
    const { view, type, press } = await renderComposer("Fix the retry loop.", [
      entry("Tell {{who}} when done.", [{ name: "who", label: "Who" }]),
    ]);

    await type(" /boiler");
    await press("Enter");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.state.doc.toString()).toBe("Fix the retry loop.");
    await type("!");

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop.");
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop. /boiler");
  });

  it("takes only the token out for a template that fills nothing, as its own undo step", async () => {
    pinHistoryClock();
    const { view, type, press } = await renderComposer("Fix the retry loop.", [entry("   ")]);

    await type(" /boiler");
    await press("Enter");
    expect(view.state.doc.toString()).toBe("Fix the retry loop.");
    await type("!");

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop.");
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop. /boiler");
  });

  it.each([[""], ["   "]])(
    "holds the form open on a required argument left as %j, the draft untouched",
    async (value) => {
      const { view, type, press } = await renderComposer("Fix the retry loop.", [
        entry("Tell {{who}} when done.", [{ name: "who", label: "Who", required: true }]),
      ]);

      await type(" /boiler");
      await press("Enter");
      fireEvent.change(await screen.findByLabelText("Who"), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Fill draft" }));
      await act(async () => {});

      expect(screen.getByRole("dialog").textContent).toContain("Required");
      expect(view.state.doc.toString()).toBe("Fix the retry loop.");

      fireEvent.change(screen.getByLabelText("Who"), { target: { value: "Ada" } });
      fireEvent.click(screen.getByRole("button", { name: "Fill draft" }));
      await act(async () => {});

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(view.state.doc.toString()).toBe("Fix the retry loop.\n\nTell Ada when done.");
    }
  );

  it("offers installed templates and this project's own, never another project's", async () => {
    useProjectStore.setState({
      currentProject: { id: "p1", name: "Repo", path: "/repo", emoji: "", lastOpened: 0 },
    });
    const own = (key: string, title: string, projectId: string | null): PluginPromptTemplate => ({
      ...entry("Run the tests."),
      key,
      projectId,
      template: { ...entry("Run the tests.").template, id: key, title },
    });
    const { type, rows } = await renderComposer("", [
      own("acme::installed", "Boilerplate installed", null),
      own("project__p1__acme::here", "Boilerplate here", "p1"),
      own("project__p2__acme::there", "Boilerplate there", "p2"),
    ]);

    await type("/boiler");

    const offered = rows().join("\n");
    expect(offered).toContain("Boilerplate installed");
    expect(offered).toContain("Boilerplate here");
    expect(offered).not.toContain("Boilerplate there");
  });

  it("leaves a written draft as it is when the template renders to nothing", async () => {
    const { view, type, press } = await renderComposer("Fix the retry loop.", [
      entry("{{extra}}", [{ name: "extra", label: "Extra" }]),
    ]);

    await type(" /boiler");
    await press("Enter");
    fireEvent.click(await screen.findByRole("button", { name: "Fill draft" }));
    await act(async () => {});

    expect(view.state.doc.toString()).toBe("Fix the retry loop.");
    expect(storedDraft()).toBe("Fix the retry loop.");
  });

  it("accepts an argument named like an inherited property", async () => {
    const { view, type, press } = await renderComposer("", [
      entry("Build {{constructor}}.", [
        { name: "constructor", label: "Constructor", required: true },
      ]),
    ]);

    await type("/boiler");
    await press("Enter");
    // Required, and empty: an inherited `constructor` must not read as filled.
    fireEvent.click(await screen.findByRole("button", { name: "Fill draft" }));
    await act(async () => {});
    expect(screen.getByRole("dialog").textContent).toContain("Required");
    expect(view.state.doc.toString()).toBe("");

    fireEvent.change(screen.getByLabelText("Constructor"), {
      target: { value: "the widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fill draft" }));
    await act(async () => {});

    expect(view.state.doc.toString()).toBe("Build the widget.");
  });

  it("leaves the form holding the keyboard when its row was clicked", async () => {
    const { type } = await renderComposer("", [
      entry("Tell {{who}} when done.", [{ name: "who", label: "Who", required: true }]),
    ]);

    await type("/boiler");
    const row = screen.getByRole("option", { name: /Add boilerplate/ });
    // The press reaches the composer's own handlers first, as a real one does.
    fireEvent.pointerDown(row, { button: 0 });
    fireEvent.mouseDown(row, { button: 0 });
    fireEvent.click(row);
    // The composer's late refocus and the form's initial focus both run on a frame.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
    }

    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes the form when its plugin goes, and doesn't reopen it when the plugin comes back", async () => {
    const template = entry("Tell {{who}} when done.", [{ name: "who", label: "Who" }]);
    const { type, press } = await renderComposer("", [template]);

    await type("/boiler");
    await press("Enter");
    expect(await screen.findByRole("dialog")).toBeTruthy();

    act(() => {
      usePluginRuntimeStore.setState({ promptTemplates: [] });
    });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      usePluginRuntimeStore.setState({ promptTemplates: [template] });
    });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks the plugin host for its templates once per opening of the `/` menu", async () => {
    const refresh = vi
      .spyOn(usePluginRuntimeStore.getState(), "refresh")
      .mockImplementation(() => {});
    const { type } = await renderComposer("", [entry("Run the tests.")]);
    refresh.mockClear();

    await type("/b");
    await type("oiler");
    expect(refresh).toHaveBeenCalledTimes(1);

    await type(" ");
    expect(refresh).toHaveBeenCalledTimes(1);
    await type("/");
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("HybridInputBar's own prompt templates in the `/` menu", () => {
  const mine = (body = "Run the tests.", args: PromptTemplateArgument[] = []) => ({
    id: "boilerplate",
    title: "Add my boilerplate",
    description: "From a file in my folder.",
    body,
    args,
  });

  const withFolder = (read: () => UserPromptTemplatesSnapshot) => {
    const list = vi.fn(async () => read());
    Reflect.set(window.electron, "userPromptTemplates", { list });
    return list;
  };

  const folder = (
    templates: PromptTemplateContribution[],
    problems: UserPromptTemplatesSnapshot["problems"] = []
  ): UserPromptTemplatesSnapshot => ({ directory: "/me/.daintree/templates", templates, problems });

  it("lists a template from the folder in the band, attributed to the person", async () => {
    withFolder(() => folder([mine()]));
    const { type, rows, bands } = await renderComposer("");

    await type("/boiler");

    expect(bands()).toContain(PROMPT_TEMPLATE_BAND);
    expect(rows()).toEqual([expect.stringContaining("Add my boilerplate")]);
    expect(rows()[0]).toContain("You");
  });

  it.each(["p1", "p2"])("offers it in project %s, ahead of the plugins' on a tie", async (id) => {
    withFolder(() => folder([mine()]));
    useProjectStore.setState({
      currentProject: { id, name: "Repo", path: `/${id}`, emoji: "", lastOpened: 0 },
    });
    const { type, labels } = await renderComposer("", [entry("Run them.")]);

    await type("/boiler");

    expect(labels()).toEqual(["Add my boilerplate", "Add boilerplate"]);
  });

  it("has the row ready before the first `/` is answered, so Enter can't send the token", async () => {
    const list = vi
      .fn<() => Promise<UserPromptTemplatesSnapshot>>()
      .mockResolvedValueOnce(folder([mine()]))
      .mockImplementation(() => new Promise(() => {}));
    Reflect.set(window.electron, "userPromptTemplates", { list });
    const { view, type, press, onSend } = await renderComposer("");

    await type("/boiler");
    expect(list).toHaveBeenCalledTimes(2);
    await press("Enter");

    expect(view.state.doc.toString()).toBe("Run the tests.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([["Enter"], ["Tab"]])("fills the draft on %s and sends nothing", async (key) => {
    withFolder(() => folder([mine()]));
    const { view, type, press, onSend } = await renderComposer("");

    await type("/boiler");
    await press(key);

    expect(view.state.doc.toString()).toBe("Run the tests.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("opens the same form for its arguments, says whose it is, and sends nothing", async () => {
    withFolder(() =>
      folder([mine("Tell {{who}} when done.", [{ name: "who", label: "Who", required: true }])])
    );
    const { view, type, press, onSend } = await renderComposer("");

    await type("/boiler");
    await press("Enter");

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Your template");
    fireEvent.change(screen.getByLabelText("Who"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill draft" }));
    await act(async () => {});

    expect(view.state.doc.toString()).toBe("Tell Ada when done.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("reads the folder once per opening, so a saved or removed file shows at the next `/`", async () => {
    let templates = [mine()];
    const list = withFolder(() => folder(templates));
    const { type, press, rows, view } = await renderComposer("");
    list.mockClear();

    await type("/b");
    await type("oiler");
    expect(list).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);

    await press("Escape");
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    });
    templates = [];

    await type("/boiler");
    expect(list).toHaveBeenCalledTimes(2);
    expect(rows()).toEqual([]);
  });

  it("reads again when the window comes back with the menu still open", async () => {
    let templates = [mine()];
    const list = withFolder(() => folder(templates));
    const { type, rows } = await renderComposer("");

    await type("/boiler");
    expect(rows()).toHaveLength(1);

    templates = [];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(rows()).toEqual([]);

    // The menu closes and its listener goes with it.
    await type(" ");
    list.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(list).not.toHaveBeenCalled();
  });

  it("closes the form when the next read finds its file gone", async () => {
    withFolder(() => folder([mine("Tell {{who}}.", [{ name: "who", label: "Who" }])]));
    const { type, press } = await renderComposer("");

    await type("/boiler");
    await press("Enter");
    expect(await screen.findByRole("dialog")).toBeTruthy();

    act(() => {
      useUserPromptTemplateStore.setState({ templates: [] });
    });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names a left-out file's problem in the menu and goes to it in Settings", async () => {
    const dispatch = vi
      .spyOn(actionService, "dispatch")
      .mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof actionService.dispatch>>);
    withFolder(() => folder([mine()], [{ fileName: "bad.md", reason: "title is missing" }]));
    const { type, rows, container } = await renderComposer("");

    await type("/boiler");

    expect(rows()).toEqual([expect.stringContaining("Add my boilerplate")]);
    const note = container.querySelector<HTMLElement>("[data-autocomplete-note]")!;
    expect(note.textContent).toContain("weren't loaded");
    fireEvent.click(note);
    expect(dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      expect.objectContaining({ tab: "agents", sectionId: "agents-prompt-templates" }),
      { source: "user" }
    );
  });

  it("shows no note while the folder is healthy, or in another menu", async () => {
    withFolder(() => folder([mine()]));
    const { type, container, view, rows } = await renderComposer("");
    await type("/boiler");
    expect(rows()).toHaveLength(1);
    expect(container.querySelector("[data-autocomplete-note]")).toBeNull();

    act(() => {
      useUserPromptTemplateStore.setState({
        problems: [{ fileName: "bad.md", reason: "title is missing" }],
      });
    });
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    });
    await type("@");
    expect(container.querySelector("[data-autocomplete-note]")).toBeNull();
  });
});

describe("HybridInputBar prompt marker", () => {
  it("draws the `❯` at the glyph's own width, with no focus look of its own", async () => {
    const { container } = await renderComposer("");

    const marker = container.querySelector<HTMLElement>("[data-composer-marker]")!;
    expect(marker.textContent).toBe("❯");
    // It opens prompt history on a click, but Mod+R is the keyboard path.
    expect(marker.tabIndex).toBe(-1);
    // As drawn, whatever the class constants hold: no width of its own and no focus look.
    const drawn = marker.className.split(/\s+/);
    expect(
      drawn.filter((c) =>
        /^(min-|max-)?w-|^size-|^p[xlr]?-|^(focus|focus-visible|group-hover):/.test(c)
      )
    ).toEqual([]);
    expect(screen.queryByRole("button", { name: /command picker/i })).toBeNull();
  });

  it("focuses the composer when pressed, as anywhere else in the input area", async () => {
    const { container, view } = await renderComposer("");
    const marker = container.querySelector<HTMLElement>("[data-composer-marker]")!;
    view.contentDOM.blur();
    expect(document.activeElement).not.toBe(view.contentDOM);

    fireEvent.pointerDown(marker, { button: 0 });

    expect(document.activeElement).toBe(view.contentDOM);
  });
});
