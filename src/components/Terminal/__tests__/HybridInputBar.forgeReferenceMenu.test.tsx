// @vitest-environment jsdom
/**
 * `#` offers the project's open issues and pull requests (#14848), and stays
 * ordinary text everywhere else: a heading, a hex colour or a CSS id sends
 * exactly as typed, rows on screen or not.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, ListOptions, Page, PR } from "@shared/types/forge";

const forge = vi.hoisted(() => ({
  listIssues: vi.fn<(cwd: string, opts?: ListOptions) => Promise<Page<Issue>>>(),
  listPRs: vi.fn<(cwd: string, opts?: ListOptions) => Promise<Page<PR>>>(),
  referencePrefixes: { issue: "#", pr: "#" } as { issue?: string; pr?: string } | null,
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
    const entry =
      projectId && forge.referencePrefixes
        ? {
            pluginId: "daintree.github",
            contribution: {
              id: "github",
              name: "GitHub",
              matches: ["github.com"],
              referencePrefixes: forge.referencePrefixes,
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

import { act, cleanup, render, screen } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import type { Project } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";
import { _resetForgeReferencesForTests } from "../hooks/useForgeReferences";

const WT_ID = "/repo/wt";

// jsdom has no layout: CodeMirror measures text through Range rects it lacks.
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

function page<T>(items: T[]): Page<T> {
  return { items, nextCursor: null, hasMore: false };
}

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

function pr(number: number, title: string, updatedAt: number): PR {
  return {
    number,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: "",
    baseRef: "develop",
    headRef: "x",
    createdAt: 0,
    updatedAt,
    rawData: null,
  };
}

beforeEach(() => {
  _resetForgeReferencesForTests();
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panel = {
    id: "term-1",
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
    currentProject: { id: "p1", name: "Repo", path: "/repo" } as Project,
  });
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  forge.referencePrefixes = { issue: "#", pr: "#" };
  forge.listIssues
    .mockReset()
    .mockResolvedValue(
      page([
        issue(14848, "Suggest issues when typing #", 30),
        issue(3331, "Sidebar loses its width", 10),
      ])
    );
  forge.listPRs
    .mockReset()
    .mockResolvedValue(page([pr(14843, "Clean up long dictations", 20)]));
});

afterEach(() => {
  cleanup();
});

async function mount() {
  const onSend = vi.fn(async () => true);
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.contentDOM.focus();

  const type = async (text: string) => {
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        selection: { anchor: view.state.doc.length + text.length },
        userEvent: "input.type",
      });
    });
    // The first `#` waits on the forge.
    await act(async () => {});
  };
  const press = async (key: string) => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");
    });
  };
  const options = () => screen.queryAllByRole("option").map((option) => option.textContent ?? "");
  return { view, onSend, type, press, options };
}

describe("HybridInputBar `#` references", () => {
  it("lists open issues and pull requests, most recently updated first, on `#`", async () => {
    const { type, options } = await mount();
    await type("see #");
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe(
      "Issue and pull request autocomplete"
    );
    const rows = options();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("#14848");
    expect(rows[0]).toContain("Open issue");
    expect(rows[1]).toContain("#14843");
    expect(rows[1]).toContain("Open PR");
    expect(rows[2]).toContain("#3331");
  });

  it("narrows the rows as digits are typed, without asking the forge again", async () => {
    const { type, options } = await mount();
    await type("see #");
    await type("148");
    expect(options().map((row) => row.match(/#\d+/)?.[0])).toEqual(["#14848", "#14843"]);
    expect(forge.listIssues).toHaveBeenCalledTimes(1);
    expect(forge.listPRs).toHaveBeenCalledTimes(1);
  });

  it("inserts the first row on Tab and sends nothing", async () => {
    const { view, type, press, onSend } = await mount();
    await type("see #148");
    await press("Tab");
    expect(view.state.doc.toString()).toBe("see #14848 ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("inserts a row the arrows chose on Enter", async () => {
    const { view, type, press, onSend } = await mount();
    await type("see #148");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("Enter");
    expect(view.state.doc.toString()).toBe("see #14843 ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([["color: #333"], ["fix #sidebar"], ["# Heading"], ["color: #fff"], ["#!/bin/bash"]])(
    "sends %j exactly as typed on Enter",
    async (text) => {
      const { type, press, onSend } = await mount();
      await type(text);
      await press("Enter");
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend.mock.calls[0]![0]).toMatchObject({ text });
    }
  );

  it("shows rows for a hex colour that matches a number, and still sends it as typed", async () => {
    const { type, press, onSend, options } = await mount();
    await type("color: #333");
    expect(options()).toHaveLength(1);
    await press("Enter");
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "color: #333" });
  });

  it("opens no menu when the provider declares no reference prefixes", async () => {
    forge.referencePrefixes = null;
    const { type, options } = await mount();
    await type("see #");
    expect(options()).toEqual([]);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(forge.listIssues).not.toHaveBeenCalled();
  });

  it("opens no menu when the forge can't be read", async () => {
    forge.listIssues.mockRejectedValue(new Error("No credential"));
    forge.listPRs.mockRejectedValue(new Error("No credential"));
    const { type, press, onSend } = await mount();
    await type("see #1");
    expect(screen.queryByRole("listbox")).toBeNull();
    await press("Enter");
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "see #1" });
  });
});
