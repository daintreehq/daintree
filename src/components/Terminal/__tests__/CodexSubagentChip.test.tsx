// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSubagent, CodexSubagentsResult } from "@shared/types/ipc/codexSubagents";

const listSubagents = vi.hoisted(() => vi.fn());
const readSubagentTranscript = vi.hoisted(() => vi.fn());

vi.mock("@/clients/codexClient", () => ({
  codexClient: { listSubagents, readSubagentTranscript },
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

let mockPanel: Record<string, unknown> = {};

vi.mock("@/store", () => ({
  usePanelStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ panelsById: { t1: mockPanel } }),
}));

// The real popover lazy-loads Radix and renders nothing until primed, which
// would hide the list this suite is about. Trigger and content render inline.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { CodexSubagentChip } from "../CodexSubagentChip";

function subagent(overrides: Partial<CodexSubagent> = {}): CodexSubagent {
  return {
    threadId: "child-1",
    parentThreadId: "root",
    nickname: "Meitner",
    role: "reviewer",
    preview: "Review the diff",
    cwd: "/repo",
    status: { type: "notLoaded" },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    acceptsDirectInput: false,
    ...overrides,
  };
}

function ok(subagents: CodexSubagent[]): CodexSubagentsResult {
  return {
    status: "ok",
    parentThreadId: "root",
    matchedBy: "cwd-recency",
    subagents,
    candidates: [],
  };
}

/** The hook short-circuits unless `window.electron` exists, so stand one up. */
function setElectronBridge(present: boolean) {
  if (present) Reflect.set(window, "electron", {});
  else Reflect.deleteProperty(window, "electron");
}

beforeEach(() => {
  listSubagents.mockReset();
  readSubagentTranscript.mockReset();
  mockPanel = { id: "t1", kind: "terminal", launchAgentId: "codex", cwd: "/repo" };
  setElectronBridge(true);
});

afterEach(() => {
  setElectronBridge(false);
  vi.restoreAllMocks();
});

describe("CodexSubagentChip", () => {
  it("never queries for a terminal that is not running Codex", async () => {
    mockPanel = { id: "t1", kind: "terminal", launchAgentId: "claude" };
    render(<CodexSubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).not.toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays invisible while the session reports no subagents", async () => {
    listSubagents.mockResolvedValue(ok([]));
    render(<CodexSubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /subagent/i })).toBeNull();
  });

  it("stays invisible when the lookup could not resolve a session", async () => {
    listSubagents.mockResolvedValue({ status: "unavailable", reason: "no-session" });
    render(<CodexSubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /subagent/i })).toBeNull();
  });

  it("counts the children it found and names each one read-only", async () => {
    listSubagents.mockResolvedValue(
      ok([
        subagent(),
        subagent({ threadId: "child-2", nickname: "Kant", preview: "Run the tests" }),
      ])
    );

    render(<CodexSubagentChip terminalId="t1" />);

    expect(await screen.findByRole("button", { name: "2 Codex subagents" })).toBeTruthy();
    expect(screen.getByText("Meitner")).toBeTruthy();
    expect(screen.getByText("Kant")).toBeTruthy();
    // Read-only surface: nothing here may take input for a child session.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says the parent is a guess when more than one session ran in the folder", async () => {
    listSubagents.mockResolvedValue({
      status: "ok",
      parentThreadId: "root",
      matchedBy: "cwd-recency",
      subagents: [subagent()],
      candidates: [
        { threadId: "root", preview: "one", createdAt: 1 },
        { threadId: "other", preview: "two", createdAt: 2 },
      ],
    });

    render(<CodexSubagentChip terminalId="t1" />);

    expect(await screen.findByText(/best guess/i)).toBeTruthy();
  });

  it("shows no ambiguity warning when the match was unambiguous", async () => {
    listSubagents.mockResolvedValue(ok([subagent()]));
    render(<CodexSubagentChip terminalId="t1" />);
    await screen.findByText("Meitner");
    expect(screen.queryByText(/best guess/i)).toBeNull();
  });

  it("does not query the pty host once the terminal has exited", async () => {
    mockPanel = { id: "t1", kind: "terminal", launchAgentId: "codex", hasPty: false };
    render(<CodexSubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).not.toHaveBeenCalled());
  });
});
