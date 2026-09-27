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

// The app mounts one TooltipProvider at the root; the trigger renders inline here
// and the hover text, which this suite does not assert on, not at all.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
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

  it("lists the children that need the user ahead of the rest, in provider order otherwise", async () => {
    listSubagents.mockResolvedValue(
      ok([
        subagent({ id: "a", label: "Quiet one" }),
        subagent({ id: "b", label: "Broken", status: { type: "error" } }),
        subagent({ id: "c", label: "Quiet two", status: { type: "working" } }),
        subagent({ id: "d", label: "Asking", status: { type: "blocked", reason: "approval" } }),
      ])
    );
    render(<SubagentChip terminalId="t1" />);
    await screen.findByText("Asking");

    const order = screen
      .getAllByRole("button", { expanded: false })
      .map((row) => row.textContent ?? "")
      .map((text) => ["Asking", "Broken", "Quiet one", "Quiet two"].find((n) => text.includes(n)));
    expect(order).toEqual(["Asking", "Broken", "Quiet one", "Quiet two"]);
  });

  it("says on the chip itself when a child is waiting on the user", async () => {
    listSubagents.mockResolvedValue(
      ok([subagent(), subagent({ id: "c2", status: { type: "blocked", reason: "input" } })])
    );
    render(<SubagentChip terminalId="t1" />);
    const chip = await screen.findByRole("button", { name: /^2 Codex subagents/ });
    expect(chip.getAttribute("aria-label")).toMatch(/1 waiting/);
  });

  it("keeps the refresh button focusable while its lookup is in flight", async () => {
    listSubagents.mockResolvedValueOnce(ok([subagent()]));
    render(<SubagentChip terminalId="t1" />);
    const refresh = await screen.findByRole("button", { name: "Refresh subagents" });

    listSubagents.mockReturnValueOnce(new Promise(() => {}));
    refresh.focus();
    fireEvent.click(refresh);

    await waitFor(() => expect(refresh.getAttribute("aria-disabled")).toBe("true"));
    // A natively disabled button would have thrown focus to the page.
    expect(refresh.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(refresh);
  });

  it("keeps showing the children it found when a refresh fails, and says so", async () => {
    listSubagents.mockResolvedValueOnce(ok([subagent()]));
    render(<SubagentChip terminalId="t1" />);
    const refresh = await screen.findByRole("button", { name: "Refresh subagents" });

    listSubagents.mockResolvedValueOnce({ status: "unavailable", reason: "timeout" });
    fireEvent.click(refresh);

    // Shown in the popover and announced through the status node.
    expect((await screen.findAllByText(/Couldn't refresh/)).length).toBeGreaterThan(0);
    expect(screen.getByText("Meitner")).toBeTruthy();
  });

  it("does not turn each open transcript into a landmark", async () => {
    listSubagents.mockResolvedValue(ok([subagent(), subagent({ id: "child-2", label: "Kant" })]));
    readSubagentTranscript.mockResolvedValue({
      status: "ok",
      subagentId: "child-1",
      messages: [{ role: "reply", text: "All good" }],
      truncated: false,
    });
    render(<SubagentChip terminalId="t1" />);
    fireEvent.click(await screen.findByText("Meitner"));
    fireEvent.click(screen.getByText("Kant"));
    await screen.findAllByText("All good");

    expect(screen.queryAllByRole("region")).toHaveLength(0);
    // The disclosure still points at the panel it shows.
    const row = screen.getByText("Meitner").closest("button")!;
    expect(document.getElementById(row.getAttribute("aria-controls")!)).not.toBeNull();
  });

  it("shows a retried transcript read in progress instead of leaving the error up", async () => {
    listSubagents.mockResolvedValue(ok([subagent()]));
    readSubagentTranscript.mockResolvedValueOnce({ status: "unavailable", reason: "timeout" });
    render(<SubagentChip terminalId="t1" />);
    fireEvent.click(await screen.findByText("Meitner"));

    const retry = await screen.findByRole("button", { name: "Retry" });
    readSubagentTranscript.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(retry);

    await waitFor(() => expect(screen.queryByText(/took too long/)).toBeNull());
    expect(await screen.findByText("Loading transcript")).toBeTruthy();
  });

  it("hands focus back to the row when Retry takes itself away", async () => {
    listSubagents.mockResolvedValue(ok([subagent()]));
    readSubagentTranscript.mockResolvedValueOnce({ status: "unavailable", reason: "timeout" });
    render(<SubagentChip terminalId="t1" />);
    fireEvent.click(await screen.findByText("Meitner"));

    const retry = await screen.findByRole("button", { name: "Retry" });
    readSubagentTranscript.mockReturnValueOnce(new Promise(() => {}));
    retry.focus();
    fireEvent.click(retry, { detail: 0 });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByText("Meitner").closest("button"));
  });

  it("tells assistive technology when a refresh it asked for starts and finishes", async () => {
    listSubagents.mockResolvedValueOnce(ok([subagent()]));
    render(<SubagentChip terminalId="t1" />);
    const refresh = await screen.findByRole("button", { name: "Refresh subagents" });
    const status = () =>
      screen
        .getAllByRole("status")
        .map((node) => node.textContent ?? "")
        .join(" ");
    // Nothing to say until the user asks.
    expect(status()).not.toMatch(/Refresh|updated/);

    let answer: (value: unknown) => void = () => {};
    listSubagents.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    fireEvent.click(refresh);
    await waitFor(() => expect(status()).toMatch(/Refreshing subagents/));

    answer(ok([subagent()]));
    await waitFor(() => expect(status()).toMatch(/Subagents updated/));
  });

  it("offers Retry beside a failed refresh, and it asks again", async () => {
    listSubagents.mockResolvedValueOnce(ok([subagent()]));
    render(<SubagentChip terminalId="t1" />);
    const refresh = await screen.findByRole("button", { name: "Refresh subagents" });

    listSubagents.mockResolvedValueOnce({ status: "unavailable", reason: "timeout" });
    fireEvent.click(refresh);
    const retry = await screen.findByRole("button", { name: "Retry" });

    listSubagents.mockResolvedValueOnce(ok([subagent({ label: "Kant" })]));
    fireEvent.click(retry);
    expect(await screen.findByText("Kant")).toBeTruthy();
    expect(screen.queryByText(/Couldn't refresh/)).toBeNull();
  });

  it("keeps focus and announces progress when the refresh notice's Retry is used", async () => {
    listSubagents.mockResolvedValueOnce(ok([subagent()]));
    render(<SubagentChip terminalId="t1" />);
    const refresh = await screen.findByRole("button", { name: "Refresh subagents" });
    listSubagents.mockResolvedValueOnce({ status: "unavailable", reason: "timeout" });
    fireEvent.click(refresh);
    const retry = await screen.findByRole("button", { name: "Retry" });

    let answer: (value: unknown) => void = () => {};
    listSubagents.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    retry.focus();
    fireEvent.click(retry, { detail: 0 });

    const status = () =>
      screen
        .getAllByRole("status")
        .map((node) => node.textContent ?? "")
        .join(" ");
    await waitFor(() => expect(status()).toMatch(/Refreshing subagents/));
    expect(document.activeElement).toBe(refresh);

    answer(ok([subagent()]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(document.activeElement).toBe(refresh);
  });
});
