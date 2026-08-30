// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSubagent,
  AgentSubagentsResult,
  SubagentProvider,
} from "@shared/types/ipc/agentSubagents";

const listSubagents = vi.hoisted(() => vi.fn());
const readSubagentTranscript = vi.hoisted(() => vi.fn());
const listClaudeSubagents = vi.hoisted(() => vi.fn());
const readClaudeSubagentTranscript = vi.hoisted(() => vi.fn());

vi.mock("@/clients/codexClient", () => ({
  codexClient: { listSubagents, readSubagentTranscript },
}));

vi.mock("@/clients/claudeClient", () => ({
  claudeClient: {
    listSubagents: listClaudeSubagents,
    readSubagentTranscript: readClaudeSubagentTranscript,
  },
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

import { SubagentChip } from "../SubagentChip";
import { __resetSubagentThrottle } from "@/hooks/useSubagents";

function subagent(overrides: Partial<AgentSubagent> = {}): AgentSubagent {
  return {
    id: "child-1",
    label: "Meitner",
    role: "reviewer",
    preview: "Review the diff",
    model: null,
    depth: null,
    status: { type: "unknown", reason: "not-loaded" },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function ok(
  subagents: AgentSubagent[],
  provider: SubagentProvider = "codex"
): AgentSubagentsResult {
  return { status: "ok", provider, parentId: "root", subagents };
}

/** The hook short-circuits unless `window.electron` exists, so stand one up. */
function setElectronBridge(present: boolean) {
  if (present) Reflect.set(window, "electron", {});
  else Reflect.deleteProperty(window, "electron");
}

beforeEach(() => {
  listSubagents.mockReset();
  readSubagentTranscript.mockReset();
  listClaudeSubagents.mockReset();
  readClaudeSubagentTranscript.mockReset();
  mockPanel = { id: "t1", kind: "terminal", launchAgentId: "codex", cwd: "/repo" };
  setElectronBridge(true);
  // Module-scoped so it survives remounts in the app; must not leak between tests.
  __resetSubagentThrottle();
});

afterEach(() => {
  setElectronBridge(false);
  vi.restoreAllMocks();
});

describe("SubagentChip", () => {
  it("never queries for a terminal running an agent with no children to report", async () => {
    mockPanel = { id: "t1", kind: "terminal", launchAgentId: "gemini" };
    render(<SubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).not.toHaveBeenCalled());
    expect(listClaudeSubagents).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays invisible while the session reports no subagents", async () => {
    listSubagents.mockResolvedValue(ok([]));
    render(<SubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /subagent/i })).toBeNull();
  });

  it("stays invisible when the lookup could not resolve a session", async () => {
    listSubagents.mockResolvedValue({ status: "unavailable", reason: "no-session" });
    render(<SubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /subagent/i })).toBeNull();
  });

  it("counts the children it found and names each one read-only", async () => {
    listSubagents.mockResolvedValue(
      ok([subagent(), subagent({ id: "child-2", label: "Kant", preview: "Run the tests" })])
    );

    render(<SubagentChip terminalId="t1" />);

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
    render(<SubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /subagent/i })).toBeNull();
  });

  it("loads a child's transcript once on expand, addressed to that child alone", async () => {
    listSubagents.mockResolvedValue(ok([subagent(), subagent({ id: "child-2", label: "Kant" })]));
    readSubagentTranscript.mockResolvedValue({
      status: "ok",
      subagentId: "child-1",
      messages: [{ role: "reply", text: "All good" }],
      truncated: false,
    });

    render(<SubagentChip terminalId="t1" />);
    fireEvent.click(await screen.findByText("Meitner"));

    expect(await screen.findByText("All good")).toBeTruthy();
    // Exactly the child that was expanded, and only once.
    expect(readSubagentTranscript.mock.calls).toEqual([
      [{ terminalId: "t1", subagentId: "child-1" }],
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

    render(<SubagentChip terminalId="t1" />);
    fireEvent.click(await screen.findByText("Meitner"));

    const retry = await screen.findByRole("button", { name: "Retry" });
    readSubagentTranscript.mockResolvedValueOnce({
      status: "ok",
      subagentId: "child-1",
      messages: [{ role: "reply", text: "Second time" }],
      truncated: false,
    });
    fireEvent.click(retry);

    expect(await screen.findByText("Second time")).toBeTruthy();
  });

  it("exposes no way to send input to a child, whichever agent spawned it", async () => {
    listSubagents.mockResolvedValue(ok([subagent()]));

    render(<SubagentChip terminalId="t1" />);
    await screen.findByText("Meitner");

    expect(screen.queryByRole("textbox")).toBeNull();
    const actions = screen
      .getAllByRole("button")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(actions.some((label) => /send|reply|steer|prompt/i.test(label ?? ""))).toBe(false);
  });

  it("does not query the pty host once the terminal has exited", async () => {
    mockPanel = { id: "t1", kind: "terminal", launchAgentId: "codex", hasPty: false };
    render(<SubagentChip terminalId="t1" />);
    await waitFor(() => expect(listSubagents).not.toHaveBeenCalled());
  });

  it("reads a Claude terminal's children through Claude, not through Codex", async () => {
    mockPanel = { id: "t1", kind: "terminal", launchAgentId: "claude", cwd: "/repo" };
    listClaudeSubagents.mockResolvedValue(
      ok([subagent({ label: "Run the palette suite", role: "General purpose" })], "claude")
    );

    render(<SubagentChip terminalId="t1" />);

    expect(await screen.findByRole("button", { name: "1 Claude subagent" })).toBeTruthy();
    expect(screen.getByText("Claude subagents")).toBeTruthy();
    expect(screen.getByText("Run the palette suite")).toBeTruthy();
    expect(listSubagents).not.toHaveBeenCalled();
  });

  it("follows the agent the pane is running now, not the one it was launched as", async () => {
    // A relaunched pane keeps its launch id; live detection is what says which
    // store actually holds this session's children.
    mockPanel = {
      id: "t1",
      kind: "terminal",
      launchAgentId: "codex",
      runtimeIdentity: { agentId: "claude" },
      cwd: "/repo",
    };
    listClaudeSubagents.mockResolvedValue(ok([subagent()], "claude"));

    render(<SubagentChip terminalId="t1" />);

    await waitFor(() => expect(listClaudeSubagents).toHaveBeenCalled());
    expect(listSubagents).not.toHaveBeenCalled();
  });

  it("says a long transcript was shortened rather than passing it off as complete", async () => {
    listSubagents.mockResolvedValue(ok([subagent()]));
    readSubagentTranscript.mockResolvedValue({
      status: "ok",
      subagentId: "child-1",
      messages: [{ role: "reply", text: "the tail" }],
      truncated: true,
    });

    render(<SubagentChip terminalId="t1" />);
    fireEvent.click(await screen.findByText("Meitner"));

    expect(await screen.findByText(/latest messages/i)).toBeTruthy();
  });
});
