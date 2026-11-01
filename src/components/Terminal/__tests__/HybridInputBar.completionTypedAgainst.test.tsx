// @vitest-environment jsdom
/**
 * A completion typed straight in front of a word leaves that word alone when
 * it is accepted (#15872), and a dictated passage it was typed against stays
 * unedited, so a correction still on its way can land.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, ListOptions, Page } from "@shared/types/forge";

const forge = vi.hoisted(() => ({
  listIssues: vi.fn<(cwd: string, opts?: ListOptions) => Promise<Page<Issue>>>(),
  listPRs: vi.fn(),
}));

vi.mock("@/clients/forgeClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/forgeClient")>();
  return {
    ...actual,
    forgeClient: { ...actual.forgeClient, listIssues: forge.listIssues, listPRs: forge.listPRs },
  };
});

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: (projectId: string | null | undefined) => {
    const entry = projectId
      ? {
          pluginId: "daintree.github",
          contribution: {
            id: "github",
            name: "GitHub",
            matches: ["github.com"],
            referencePrefixes: { issue: "#", pr: "#" },
          },
        }
      : null;
    return {
      entry,
      providerId: entry ? "github" : null,
      resolvedVia: entry ? "hostname" : null,
      issues: { entry, providerId: entry ? "github" : null, resolvedVia: entry ? "code" : null },
      loading: false,
      refresh: () => {},
    };
  },
}));

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import {
  subscribeDictationRangeTracking,
  useDictationRangeStore,
} from "@/store/dictationRangeStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";
import { _resetForgeReferencesForTests } from "../hooks/useForgeReferences";

const WT_ID = "/repo/wt";
const PANEL = "term-1";
const PROJECT = "p1";

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

function issue(number: number, title: string, updatedAt: number): Issue {
  return {
    number,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    url: "",
    assignees: [],
    labels: [],
    createdAt: 0,
    updatedAt,
    rawData: null,
  };
}

let stopTracking: (() => void) | null = null;

beforeEach(() => {
  _resetForgeReferencesForTests();
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panel = {
    id: PANEL,
    title: "claude",
    kind: "terminal",
    cwd: WT_ID,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    detectedAgentId: "claude",
    launchAgentId: "claude",
    agentState: "waiting",
    runtimeStatus: "running",
  } as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
    panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
    focusedId: panel.id,
  });
  useProjectStore.setState({
    currentProject: { id: PROJECT, name: "Repo", path: "/repo", emoji: "", lastOpened: 0 },
  });
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  useDictationRangeStore.setState({ drafts: {}, anchors: {} });
  forge.listIssues.mockReset().mockResolvedValue({
    items: [issue(14848, "Suggest issues when typing #", 30), issue(3331, "Sidebar width", 10)],
    nextCursor: null,
    hasMore: false,
  });
  forge.listPRs.mockReset().mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
});

afterEach(() => {
  cleanup();
  stopTracking?.();
  stopTracking = null;
});

async function mount(draft: string) {
  useTerminalInputStore.getState().setDraftInput(PANEL, draft, PROJECT);
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId={PANEL} cwd={WT_ID} agentId="claude" onSend={vi.fn()} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.contentDOM.focus();

  const caretAt = async (pos: number) => {
    await act(async () => {
      view.dispatch({ selection: { anchor: pos }, userEvent: "select" });
    });
  };
  // One keystroke at a time at the caret, as typing is.
  const type = async (text: string) => {
    for (const char of text) {
      await act(async () => {
        const at = view.state.selection.main.head;
        view.dispatch({
          changes: { from: at, insert: char },
          selection: { anchor: at + 1 },
          userEvent: "input.type",
        });
      });
      await act(async () => {});
    }
  };
  const press = async (key: string) => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");
    });
  };
  const doc = () => view.state.doc.toString();
  const caret = () => view.state.selection.main.head;
  return { view, caretAt, type, press, doc, caret };
}

describe("HybridInputBar completion typed against a word", () => {
  // `#` rows are never preselected, so Enter takes one the arrows chose.
  it.each([[["Tab"]], [["ArrowDown", "Enter"]]])("keeps the word on %j", async (keys) => {
    const { caretAt, type, press, doc, caret } = await mount("fix it");
    await caretAt(0);
    await type("#148");
    expect(doc()).toBe("#148fix it");
    for (const key of keys) await press(key);
    expect(doc()).toBe("#14848 fix it");
    expect(caret()).toBe("#14848 ".length);
    expect(useTerminalInputStore.getState().getDraftInput(PANEL, PROJECT)).toBe("#14848 fix it");
  });

  it("keeps the word when a row is clicked", async () => {
    const { caretAt, type, doc } = await mount("fix it");
    await caretAt(0);
    await type("#148");
    const row = screen.getAllByRole("option")[0]!;
    await act(async () => {
      fireEvent.click(row);
    });
    expect(doc()).toBe("#14848 fix it");
  });

  it("keeps a word mid-draft too", async () => {
    const { caretAt, type, press, doc } = await mount("see that bug");
    await caretAt("see ".length);
    await type("#148");
    await press("Tab");
    expect(doc()).toBe("see #14848 that bug");
  });

  it("replaces the whole token when the caret was moved into one", async () => {
    const { caretAt, press, doc } = await mount("see #148x now");
    await caretAt("see #14".length);
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);
    await press("Tab");
    expect(doc()).toBe("see #14848 now");
  });

  it("leaves the dictated passage it was typed against unedited", async () => {
    stopTracking = subscribeDictationRangeTracking();
    const passage = "48 is still open";
    const target = { sessionId: "s1", panelId: PANEL, projectId: PROJECT };
    useDictationRangeStore.getState().expectDraftChange(PANEL, PROJECT, "", passage, {
      from: 0,
      to: 0,
      insert: passage,
    });
    useTerminalInputStore.getState().setDraftInput(PANEL, passage, PROJECT);
    useDictationRangeStore.getState().recordUtterance(target, {
      insertion: { from: 0, to: passage.length },
      words: { from: 0, to: passage.length },
    });

    const { caretAt, type, press, doc } = await mount(passage);
    await caretAt(0);
    // `#1` against `48…` reads as `#148`; the `48` was there first. A diff of
    // the drafts would place the completion's `48 ` inside the passage.
    await type("#1");
    await press("Tab");
    expect(doc()).toBe(`#14848 ${passage}`);

    const [record] = useDictationRangeStore.getState().listDictations(PANEL, PROJECT);
    const draft = useTerminalInputStore.getState().getDraftInput(PANEL, PROJECT);
    expect(record!.range.edited).toBe(false);
    expect(draft.slice(record!.range.from, record!.range.to)).toBe(passage);
    expect(record!.utterances[0]!.range.edited).toBe(false);
  });
});
