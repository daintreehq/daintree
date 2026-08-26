// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { __resetCodexSubagentThrottle } from "@/hooks/useCodexSubagents";

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
    matchedBy: "spawn-time",
    subagents,
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
  // Module-scoped so it survives remounts in the app; must not leak between tests.
  __resetCodexSubagentThrottle();
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

  it("shows nothing at all when the parent session is ambiguous", async () => {
    // Fail closed: another terminal's children are indistinguishable from
    // this one's, so the chip must not appear rather than guess.
    listSubagents.mockResolvedValue({ status: "unavailable", reason: "ambiguous-session" });
    render(<CodexSubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /subagent/i })).toBeNull();
  });

  it("loads a child's transcript once on expand, addressed to that child alone", async () => {
    listSubagents.mockResolvedValue(
      ok([subagent(), subagent({ threadId: "child-2", nickname: "Kant" })])
    );
    readSubagentTranscript.mockResolvedValue({
      status: "ok",
      threadId: "child-1",
      turns: [
        {
          turnId: "t1",
          status: "completed",
          startedAt: null,
          completedAt: null,
          messages: [{ role: "agent", text: "All good" }],
        },
      ],
    });

    render(<CodexSubagentChip terminalId="t1" />);
    fireEvent.click(await screen.findByText("Meitner"));

    expect(await screen.findByText("All good")).toBeTruthy();
    // Exactly the child that was expanded, and only once.
    expect(readSubagentTranscript.mock.calls).toEqual([
      [{ terminalId: "t1", threadId: "child-1" }],
    ]);

    // Collapsing and reopening must not refetch a transcript we already hold.
    fireEvent.click(screen.getByText("Meitner"));
    fireEvent.click(screen.getByText("Meitner"));
    await waitFor(() => expect(readSubagentTranscript).toHaveBeenCalledTimes(1));
  });

  it("offers a way out of a failed transcript read instead of wedging the row", async () => {
    listSubagents.mockResolvedValue(ok([subagent()]));
    readSubagentTranscript.mockResolvedValueOnce({
      status: "unavailable",
      reason: "protocol-error",
    });

    render(<CodexSubagentChip terminalId="t1" />);
    fireEvent.click(await screen.findByText("Meitner"));

    const retry = await screen.findByRole("button", { name: "Retry" });
    readSubagentTranscript.mockResolvedValueOnce({
      status: "ok",
      threadId: "child-1",
      turns: [
        {
          turnId: "t1",
          status: null,
          startedAt: null,
          completedAt: null,
          messages: [{ role: "agent", text: "Second time" }],
        },
      ],
    });
    fireEvent.click(retry);

    expect(await screen.findByText("Second time")).toBeTruthy();
  });

  it("exposes no way to send input to a child, even one the protocol says accepts it", async () => {
    // `acceptsDirectInput` is fail-closed in the mapper, but the UI must be
    // read-only regardless of what the protocol reports.
    listSubagents.mockResolvedValue(ok([subagent({ acceptsDirectInput: true })]));

    render(<CodexSubagentChip terminalId="t1" />);
    await screen.findByText("Meitner");

    expect(screen.queryByRole("textbox")).toBeNull();
    const actions = screen
      .getAllByRole("button")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(actions.some((label) => /send|reply|steer|prompt/i.test(label ?? ""))).toBe(false);
  });

  it("does not query the pty host once the terminal has exited", async () => {
    mockPanel = { id: "t1", kind: "terminal", launchAgentId: "codex", hasPty: false };
    render(<CodexSubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).not.toHaveBeenCalled());
  });
});
