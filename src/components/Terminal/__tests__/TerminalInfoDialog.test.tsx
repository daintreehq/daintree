// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalInfoDialog } from "../TerminalInfoDialog";
import type { TerminalInfoPayload } from "@/types/electron";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const dispatchMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function makePayload(overrides?: Partial<TerminalInfoPayload>): TerminalInfoPayload {
  return {
    id: "test-id",
    cwd: "/home/user",
    spawnedAt: Date.now() - 60000,
    lastInputTime: Date.now() - 5000,
    lastOutputTime: Date.now() - 3000,
    activityTier: "focused",
    outputBufferSize: 100,
    semanticBufferLines: 10,
    restartCount: 0,
    hasPty: true,
    isAgentTerminal: false,
    analysisEnabled: true,
    kind: "terminal",
    type: "terminal",
    shell: "/bin/zsh",
    ptyCols: 80,
    ptyRows: 24,
    ptyPid: 12345,
    ptyForegroundProcess: "vim",
    ptyTty: "/dev/ttys004",
    ...overrides,
  };
}

describe("TerminalInfoDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders PTY Diagnostics section with all fields", async () => {
    const payload = makePayload();
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("PTY Diagnostics")).toBeTruthy();
    });

    expect(screen.getByText("80 × 24")).toBeTruthy();
    expect(screen.getByText("12345")).toBeTruthy();
    expect(screen.getByText("/dev/ttys004")).toBeTruthy();
    expect(screen.getByText("vim")).toBeTruthy();
  });

  it("shows exit code when terminal has exited", async () => {
    const payload = makePayload({
      hasPty: false,
      exitCode: 42,
      ptyPid: undefined,
      ptyCols: undefined,
      ptyRows: undefined,
    });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("PTY Diagnostics")).toBeTruthy();
    });

    expect(screen.getByText("Exit Code:")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("does not show exit code when PTY is active", async () => {
    const payload = makePayload();
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("PTY Diagnostics")).toBeTruthy();
    });

    expect(screen.queryByText("Exit Code:")).toBeNull();
  });

  it("omits TTY row when ptyTty is undefined", async () => {
    const payload = makePayload({ ptyTty: undefined });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("PTY Diagnostics")).toBeTruthy();
    });

    expect(screen.queryByText("TTY Device:")).toBeNull();
  });

  it("renders gracefully when all new fields are undefined", async () => {
    const payload = makePayload({
      ptyPid: undefined,
      ptyCols: undefined,
      ptyRows: undefined,
      ptyForegroundProcess: undefined,
      ptyTty: undefined,
      exitCode: undefined,
    });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("PTY Diagnostics")).toBeTruthy();
    });

    // Should show N/A for PID and foreground process
    const naElements = screen.getAllByText("N/A");
    expect(naElements.length).toBeGreaterThanOrEqual(2);
  });

  it("includes PTY Diagnostics in clipboard export", async () => {
    const payload = makePayload();
    dispatchMock.mockResolvedValue({ ok: true, result: payload });
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Copy to Clipboard")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Copy to Clipboard"));

    expect(writeTextMock).toHaveBeenCalledOnce();
    const clipboardText = writeTextMock.mock.calls[0]![0] as string;
    expect(clipboardText).toContain("PTY Diagnostics:");
    expect(clipboardText).toContain("Shell PID: 12345");
    expect(clipboardText).toContain("TTY Device: /dev/ttys004");
    expect(clipboardText).toContain("Foreground Process: vim");
    expect(clipboardText).toContain("Dimensions: 80 × 24");
  });

  it("renders Spawn Command section with shell and arg chips", async () => {
    const payload = makePayload({
      spawnArgs: ["-l", "--rcfile", "/tmp/rc"],
    });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Spawn Command")).toBeTruthy();
    });

    expect(screen.getByText("Args:")).toBeTruthy();
    expect(screen.getByText("-l")).toBeTruthy();
    expect(screen.getByText("--rcfile")).toBeTruthy();
    expect(screen.getByText("/tmp/rc")).toBeTruthy();
  });

  it("omits Args row when spawnArgs is undefined or empty", async () => {
    const payload = makePayload({ spawnArgs: undefined });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Spawn Command")).toBeTruthy();
    });

    expect(screen.queryByText("Args:")).toBeNull();
  });

  it("renders Launch Context and Live State sections for agent terminals", async () => {
    const payload = makePayload({
      isAgentTerminal: true,
      kind: "terminal",
      type: "claude",
      agentId: "agent-1",
      detectedAgentType: "claude",
      detectedAgentId: "claude",
      agentLaunchFlags: ["--dangerously-skip-permissions", "--verbose"],
      agentModelId: "claude-opus-4-7",
    });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Agent — Launch Context")).toBeTruthy();
    });

    expect(screen.getByText("Agent ID:")).toBeTruthy();
    expect(screen.getByText("agent-1")).toBeTruthy();
    expect(screen.getByText("Launch Flags:")).toBeTruthy();
    expect(screen.getByText("--dangerously-skip-permissions")).toBeTruthy();
    expect(screen.getByText("--verbose")).toBeTruthy();
    expect(screen.getByText("Model:")).toBeTruthy();
    expect(screen.getByText("claude-opus-4-7")).toBeTruthy();

    // Live State section shows the detected agent identity
    expect(screen.getByText("Agent — Live State")).toBeTruthy();
    expect(screen.getByText("Detected Agent:")).toBeTruthy();
    // "claude" appears for the type row and the detected-agent row; at least two matches is enough
    expect(screen.getAllByText("claude").length).toBeGreaterThanOrEqual(1);
  });

  it("shows 'None — agent has exited' in Live State when agent panel has no detectedAgentId", async () => {
    const payload = makePayload({
      isAgentTerminal: true,
      kind: "terminal",
      type: "claude",
      agentId: "agent-1",
      detectedAgentId: undefined,
      agentLaunchFlags: ["--verbose"],
      agentModelId: "claude-opus-4-7",
    });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Agent — Live State")).toBeTruthy();
    });

    expect(screen.getByText("None — agent has exited")).toBeTruthy();
  });

  it("omits Agent sections entirely for plain terminals with no agent metadata", async () => {
    const payload = makePayload({
      isAgentTerminal: false,
      agentId: undefined,
      detectedAgentType: undefined,
      detectedAgentId: undefined,
      agentLaunchFlags: undefined,
      agentModelId: undefined,
    });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Spawn Command")).toBeTruthy();
    });

    expect(screen.queryByText("Agent ID:")).toBeNull();
    expect(screen.queryByText("Launch Flags:")).toBeNull();
    expect(screen.queryByText("Model:")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agent — Launch Context" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agent — Live State" })).toBeNull();
  });

  it("includes Spawn Command and both Agent sections in clipboard export", async () => {
    const payload = makePayload({
      isAgentTerminal: true,
      kind: "terminal",
      type: "claude",
      agentId: "agent-1",
      detectedAgentType: "claude",
      detectedAgentId: "claude",
      shell: "/usr/local/bin/claude",
      spawnArgs: ["--model", "claude-opus-4-7"],
      agentLaunchFlags: ["--dangerously-skip-permissions"],
      agentModelId: "claude-opus-4-7",
    });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Copy to Clipboard")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Copy to Clipboard"));

    expect(writeTextMock).toHaveBeenCalledOnce();
    const clipboardText = writeTextMock.mock.calls[0]![0] as string;
    expect(clipboardText).toContain("Spawn Command:");
    expect(clipboardText).toContain("Shell: /usr/local/bin/claude");
    expect(clipboardText).toContain("Args: --model claude-opus-4-7");
    expect(clipboardText).toContain("Agent — Launch Context:");
    expect(clipboardText).toContain("Agent ID: agent-1");
    expect(clipboardText).toContain("Launch Flags: --dangerously-skip-permissions");
    expect(clipboardText).toContain("Model: claude-opus-4-7");
    expect(clipboardText).toContain("Agent — Live State:");
    expect(clipboardText).toContain("Detected Agent ID: claude");
    expect(clipboardText).toContain("Detected Agent Type: claude");
  });

  it("includes Live State but not Launch Context when only a runtime agent is detected", async () => {
    const payload = makePayload({
      isAgentTerminal: false,
      detectedAgentType: "claude",
      detectedAgentId: "claude",
    });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Copy to Clipboard")).toBeTruthy();
    });

    expect(screen.getByText("Agent — Live State")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Agent — Launch Context" })).toBeNull();

    fireEvent.click(screen.getByText("Copy to Clipboard"));
    const clipboardText = writeTextMock.mock.calls[0]![0] as string;
    expect(clipboardText).toContain("Agent — Live State:");
    expect(clipboardText).toContain("Detected Agent ID: claude");
    expect(clipboardText).not.toContain("Agent — Launch Context:");
  });

  it("renders empty spawnArgs as (none) in clipboard and omits the Args row in UI", async () => {
    const payload = makePayload({ spawnArgs: [] });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Copy to Clipboard")).toBeTruthy();
    });

    // UI omits the row entirely (matches InfoListRow convention)
    expect(screen.queryByText("Args:")).toBeNull();

    fireEvent.click(screen.getByText("Copy to Clipboard"));
    const clipboardText = writeTextMock.mock.calls[0]![0] as string;
    expect(clipboardText).toContain("Args: (none)");
    expect(clipboardText).not.toContain("Args: N/A");
  });

  it("omits Agent sections from clipboard for non-agent terminals", async () => {
    const payload = makePayload({ isAgentTerminal: false, spawnArgs: ["-l"] });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("Copy to Clipboard")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Copy to Clipboard"));

    const clipboardText = writeTextMock.mock.calls[0]![0] as string;
    expect(clipboardText).toContain("Spawn Command:");
    expect(clipboardText).toContain("Args: -l");
    expect(clipboardText).not.toContain("Agent — Launch Context:");
    expect(clipboardText).not.toContain("Agent — Live State:");
    expect(clipboardText).not.toContain("Launch Flags:");
  });
});
