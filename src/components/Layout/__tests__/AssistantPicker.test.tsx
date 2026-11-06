// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { AgentDirectory, AgentDirectoryLiveEntry } from "@shared/types/agentDirectory";

const openInAssistantMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ ok: true } | { ok: false; reason: "not-attached" }> => ({ ok: true }))
);
vi.mock("@/services/assistantSubject", () => ({ openInAssistant: openInAssistantMock }));

import { AssistantPicker } from "../AssistantPicker";
import { useCanopyStore } from "@/store/canopyStore";
import { useProjectStore } from "@/store/projectStore";

function assistant(
  lane: number,
  overrides: Partial<AgentDirectoryLiveEntry> = {}
): AgentDirectoryLiveEntry {
  return {
    state: "live",
    role: "assistant",
    subject: {
      hostId: "local",
      scope: { kind: "project", projectId: "p1" },
      terminalId: `help-${lane}`,
      incarnation: 1,
      lane,
    },
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    since: 1,
    label: null,
    attached: true,
    handback: null,
    ...overrides,
  };
}

let directory: AgentDirectory;
let canopy: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  directory = {
    coverage: "ok",
    observedAt: 1,
    complete: true,
    omitted: 0,
    entries: [assistant(0), assistant(1, { agentId: "codex" })],
  };
  canopy = {
    readAgentDirectory: vi.fn(async () => directory),
    watchAssistantTerminal: vi.fn(),
    watchTerminal: vi.fn(),
    setActive: vi.fn(),
    refresh: vi.fn(),
  };
  Object.defineProperty(window, "electron", {
    value: { canopy },
    configurable: true,
    writable: true,
  });
  useProjectStore.setState({
    projects: [{ id: "p1", path: "/repo", name: "app", emoji: "🌳", lastOpened: 1 }],
  });
  // Canopy's reading is off: the picker doesn't need it.
  useCanopyStore.setState({ mode: "unset", snapshot: null, assistantHandbacksSeen: {} });
});

afterEach(() => {
  window.localStorage.removeItem("daintree-canopy-assistant-handbacks");
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function options() {
  return [...document.querySelectorAll<HTMLElement>("[role=option]")];
}

describe("AssistantPicker", () => {
  it("lists each running assistant by its place, with Canopy off, reading nothing else", async () => {
    render(<AssistantPicker open onClose={() => {}} />);
    await flush();
    expect(options().map((option) => option.textContent)).toEqual([
      "app · Session 1At its prompt · Claude",
      "app · Session 2At its prompt · Codex",
    ]);
    expect(canopy.readAgentDirectory).toHaveBeenCalled();
    for (const name of ["watchAssistantTerminal", "watchTerminal", "setActive", "refresh"]) {
      expect(canopy[name]).not.toHaveBeenCalled();
    }
    expect(openInAssistantMock).not.toHaveBeenCalled();
  });

  it("reads nothing while closed", () => {
    render(<AssistantPicker open={false} onClose={() => {}} />);
    expect(canopy.readAgentDirectory).not.toHaveBeenCalled();
  });

  it("goes to the lane chosen with the keyboard, and closes", async () => {
    const onClose = vi.fn();
    render(<AssistantPicker open onClose={onClose} />);
    await flush();
    const list = document.querySelector<HTMLElement>("[role=listbox]")!;
    await act(async () => {
      fireEvent.keyDown(list, { key: "ArrowDown" });
    });
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      fireEvent.keyDown(list, { key: "Enter" });
    });
    expect(openInAssistantMock).toHaveBeenCalledWith(assistant(1).subject);
    expect(onClose).toHaveBeenCalled();
  });

  it("stays open and says why when the lane can't be opened", async () => {
    openInAssistantMock.mockResolvedValueOnce({ ok: false, reason: "not-attached" });
    const onClose = vi.fn();
    render(<AssistantPicker open onClose={onClose} />);
    await flush();
    await act(async () => {
      fireEvent.click(options()[0]!);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role=status]")?.textContent).toContain(
      "runs without a window here"
    );
  });

  // No Canopy reading ever covers an assistant, so an approval or question the
  // patterns saw is at most unread, never the amber waiting mark (#16059).
  it("never draws an observed approval or question in the waiting hue", async () => {
    directory.entries = [
      assistant(0, { waitingReason: "approval" }),
      assistant(1, { waitingReason: "question" }),
    ];
    render(<AssistantPicker open onClose={() => {}} />);
    await flush();
    expect(options().map((option) => option.getAttribute("data-ask"))).toEqual([
      "approval",
      "question",
    ]);
    for (const option of options()) {
      expect(option.querySelector('[class*="text-state-waiting"]')).toBeNull();
      // The state glyph alone: the unread mark, in the tone a review wears.
      const glyph = option.querySelector('[aria-hidden="true"]')?.firstElementChild;
      expect(glyph?.getAttribute("class")).toContain("text-text-primary");
    }
  });

  it("marks a handback seen once the assistant it came from is opened", async () => {
    directory.entries = [assistant(0, { handback: { observedAt: 50 } })];
    render(<AssistantPicker open onClose={() => {}} />);
    await flush();
    expect(options()[0]!.getAttribute("data-ask")).toBe("handback");
    await act(async () => {
      fireEvent.click(options()[0]!);
    });
    expect(Object.values(useCanopyStore.getState().assistantHandbacksSeen)).toEqual([50]);
  });

  it("keeps a handback unseen when its assistant couldn't be opened", async () => {
    openInAssistantMock.mockResolvedValueOnce({ ok: false, reason: "not-attached" });
    directory.entries = [assistant(0, { handback: { observedAt: 50 } })];
    render(<AssistantPicker open onClose={() => {}} />);
    await flush();
    await act(async () => {
      fireEvent.click(options()[0]!);
    });
    expect(useCanopyStore.getState().assistantHandbacksSeen).toEqual({});
  });

  it("takes the keyboard into the list once it arrives", async () => {
    render(<AssistantPicker open onClose={() => {}} />);
    await flush();
    expect(document.activeElement?.getAttribute("role")).toBe("listbox");
  });

  it("says when it couldn't list every assistant, rather than that none run", async () => {
    directory = {
      coverage: "unreachable",
      observedAt: null,
      complete: false,
      omitted: 0,
      entries: [],
    };
    render(<AssistantPicker open onClose={() => {}} />);
    await flush();
    expect(document.body.textContent).toContain("Daintree couldn't list every assistant just now.");
  });
});
