import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { actionServiceMock, panelState, viewWorkspace } = vi.hoisted(() => ({
  actionServiceMock: {
    has: vi.fn<(id: string) => boolean>(() => true),
    dispatch: vi.fn(() => Promise.resolve({ ok: true })),
  },
  panelState: { panelsById: {} as Record<string, { kind?: string; worktreeId?: string }> },
  viewWorkspace: { id: "proj-a" as string | null },
}));

vi.mock("@/services/ActionService", () => ({ actionService: actionServiceMock }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => panelState } }));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => viewWorkspace.id }));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

import { usePluginRuntimeStore, type PluginTerminalLink } from "@/store/pluginRuntimeStore";
import { usePluginTerminalLinkPreferencesStore } from "@/store/pluginTerminalLinkPreferencesStore";
import {
  activatePluginPatternLink,
  activatePluginUrlLink,
  findPluginPatternLinks,
  findPluginUrlClaim,
  getLivePluginTerminalLinks,
  getTerminalLinkSubject,
  isPluginPatternLinkCurrent,
  selectPluginPatternLinks,
} from "../pluginTerminalLinks";
import {
  TerminalLinkMatchClient,
  _setTerminalLinkMatchClientForTest,
  type TerminalLinkWorker,
} from "../terminalLinkMatchClient";
import { createTerminalLinkMatchHandler } from "../terminalLinkMatchWork";
import { TERMINAL_LINK_MAX_MATCHES_PER_ROW } from "@shared/utils/pluginTerminalLinks";

/** A worker that runs the real handler, answering on a microtask. */
function inlineWorker(): TerminalLinkWorker {
  const worker: TerminalLinkWorker = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: (request) => {
      queueMicrotask(() => handle(request));
    },
  };
  const handle = createTerminalLinkMatchHandler((message) => worker.onmessage?.({ data: message }));
  return worker;
}

function entry(
  pluginId: string,
  link: Omit<PluginTerminalLink["link"], "actionId">,
  projectId: string | null = null
): PluginTerminalLink {
  return {
    key: `${pluginId}::${link.id}`,
    pluginId,
    pluginName: `Plugin ${pluginId}`,
    projectId,
    actionId: `${pluginId}.open`,
    link: { ...link, actionId: `${pluginId}.open` },
  };
}

function setLinks(links: PluginTerminalLink[]) {
  usePluginRuntimeStore.setState({ terminalLinks: links });
}

beforeEach(() => {
  _setTerminalLinkMatchClientForTest(new TerminalLinkMatchClient(inlineWorker));
  actionServiceMock.has.mockReset().mockReturnValue(true);
  actionServiceMock.dispatch.mockClear();
  panelState.panelsById = { "term-1": { kind: "terminal", worktreeId: "wt-1" } };
  viewWorkspace.id = "proj-a";
  usePluginTerminalLinkPreferencesStore.setState({ disabled: {} });
});

afterEach(() => {
  setLinks([]);
  _setTerminalLinkMatchClientForTest(null);
});

describe("getLivePluginTerminalLinks", () => {
  it("keeps installed plugins and this view's project plugins, ordered by plugin id", () => {
    setLinks([
      entry("zeta", { id: "a", pattern: "Z-\\d" }),
      entry("project__proj-b__acme", { id: "b", pattern: "B-\\d" }, "proj-b"),
      entry("project__proj-a__acme", { id: "c", pattern: "C-\\d" }, "proj-a"),
      entry("alpha", { id: "d", pattern: "A-\\d" }),
    ]);
    expect(getLivePluginTerminalLinks().map((e) => e.pluginId)).toEqual([
      "alpha",
      "project__proj-a__acme",
      "zeta",
    ]);
  });

  it("drops a plugin the user switched off and one whose command isn't registered", () => {
    setLinks([
      entry("off", { id: "a", pattern: "A-\\d" }),
      entry("gone", { id: "b", pattern: "B-\\d" }),
      entry("on", { id: "c", pattern: "C-\\d" }),
    ]);
    usePluginTerminalLinkPreferencesStore.getState().setEnabled("off", false);
    actionServiceMock.has.mockImplementation((id) => id !== "gone.open");
    expect(getLivePluginTerminalLinks().map((e) => e.pluginId)).toEqual(["on"]);
  });
});

describe("findPluginPatternLinks", () => {
  it("lets the earlier plugin keep an overlapping match", async () => {
    setLinks([
      entry("b-plugin", { id: "wide", pattern: "INV-\\d{1,4}" }),
      entry("a-plugin", { id: "narrow", pattern: "\\d{1,4}" }),
    ]);
    const found = await findPluginPatternLinks("INV-42 and 7");
    expect(found.map((m) => [m.entry.pluginId, m.text])).toEqual([
      ["a-plugin", "42"],
      ["a-plugin", "7"],
    ]);
  });

  it("never runs a pattern that fails the safety check", async () => {
    setLinks([entry("bad", { id: "x", pattern: "(a+)+b" })]);
    expect(await findPluginPatternLinks("aaaaaaaaaaaaaaaaaaaaaaaaaaab")).toEqual([]);
  });

  it("asks nothing of the worker when no live matcher has a pattern", async () => {
    setLinks([entry("acme", { id: "rec", url: { scheme: "https", host: "records.example.com" } })]);
    const match = vi.spyOn(TerminalLinkMatchClient.prototype, "match");
    expect(await findPluginPatternLinks("INV-1")).toEqual([]);
    expect(match).not.toHaveBeenCalled();
    match.mockRestore();
  });
});

describe("selectPluginPatternLinks", () => {
  it("counts only kept matches toward the row cap", () => {
    const wide = entry("a", { id: "wide", pattern: "x" });
    const narrow = entry("b", { id: "narrow", pattern: "y" });
    const overlapped = Array.from({ length: TERMINAL_LINK_MAX_MATCHES_PER_ROW }, (_, i) => ({
      index: i,
      text: "x",
      groups: [],
    }));
    const found = selectPluginPatternLinks([wide, narrow], {
      "a::wide": [{ index: 0, text: "x".repeat(40), groups: [] }],
      "b::narrow": [...overlapped, { index: 50, text: "y", groups: [] }],
    });
    expect(found.map((m) => [m.entry.key, m.index])).toEqual([
      ["a::wide", 0],
      ["b::narrow", 50],
    ]);
  });
});

describe("findPluginUrlClaim", () => {
  it("prefers the longest path prefix, then the earlier plugin", () => {
    setLinks([
      entry("b", { id: "all", url: { scheme: "https", host: "records.example.com" } }),
      entry("a", { id: "all", url: { scheme: "https", host: "records.example.com" } }),
      entry("c", {
        id: "deep",
        url: { scheme: "https", host: "records.example.com", pathPrefix: "/r/" },
      }),
    ]);
    expect(findPluginUrlClaim("https://records.example.com/r/1")?.pluginId).toBe("c");
    expect(findPluginUrlClaim("https://records.example.com/x")?.pluginId).toBe("a");
    expect(findPluginUrlClaim("https://other.example.com/r/1")).toBeNull();
  });
});

describe("activation", () => {
  it("dispatches a pattern match with its text, groups and the terminal's subject", async () => {
    const live = entry("acme", { id: "inv", pattern: "INV-(\\d{1,4})" });
    setLinks([live]);
    const [match] = await findPluginPatternLinks("INV-42");
    expect(activatePluginPatternLink(match!, "term-1")).toBe(true);
    expect(actionServiceMock.dispatch).toHaveBeenCalledWith(
      "acme.open",
      {
        panelId: "term-1",
        panelKind: "terminal",
        worktreeId: "wt-1",
        text: "INV-42",
        groups: ["42"],
      },
      { source: "user" }
    );
  });

  it("re-checks the switch on click, since it may have flipped since the hover", async () => {
    setLinks([entry("acme", { id: "inv", pattern: "INV-\\d{1,4}" })]);
    const [match] = await findPluginPatternLinks("INV-42");
    usePluginTerminalLinkPreferencesStore.getState().setEnabled("acme", false);
    expect(isPluginPatternLinkCurrent(match!)).toBe(false);
    expect(activatePluginPatternLink(match!, "term-1")).toBe(false);
    expect(actionServiceMock.dispatch).not.toHaveBeenCalled();
  });

  it("refuses a match whose matcher a reload changed or removed, though the command remains", async () => {
    setLinks([entry("acme", { id: "inv", pattern: "INV-\\d{1,4}" })]);
    const [match] = await findPluginPatternLinks("INV-42");

    setLinks([entry("acme", { id: "inv", pattern: "INV-\\d{1,8}" })]);
    expect(activatePluginPatternLink(match!, "term-1")).toBe(false);
    setLinks([]);
    expect(activatePluginPatternLink(match!, "term-1")).toBe(false);
    expect(actionServiceMock.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches a claimed URL, and leaves an unclaimed one to the caller", () => {
    setLinks([entry("acme", { id: "rec", url: { scheme: "https", host: "records.example.com" } })]);
    expect(activatePluginUrlLink("https://records.example.com/1", "term-1")).toBe(true);
    expect(actionServiceMock.dispatch).toHaveBeenCalledWith(
      "acme.open",
      {
        panelId: "term-1",
        panelKind: "terminal",
        worktreeId: "wt-1",
        url: "https://records.example.com/1",
      },
      { source: "user" }
    );
    expect(activatePluginUrlLink("https://example.org/1", "term-1")).toBe(false);
  });

  it("offers nothing for a terminal with no panel, and omits an absent worktree", () => {
    setLinks([entry("acme", { id: "rec", url: { scheme: "https", host: "records.example.com" } })]);
    expect(activatePluginUrlLink("https://records.example.com/1", "unknown")).toBe(false);
    expect(getTerminalLinkSubject("unknown")).toBeNull();
    panelState.panelsById = { loose: { kind: "terminal" } };
    expect(getTerminalLinkSubject("loose")).toEqual({ panelId: "loose", panelKind: "terminal" });
  });
});
