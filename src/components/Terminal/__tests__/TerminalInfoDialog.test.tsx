// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalInfoDialog } from "../TerminalInfoDialog";
import type { TerminalInfoPayload } from "@/types/electron";

const dispatchMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
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
    const payload = makePayload({ hasPty: false, exitCode: 0, ptyPid: undefined, ptyCols: undefined, ptyRows: undefined });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("PTY Diagnostics")).toBeTruthy();
    });

    expect(screen.getByText("0")).toBeTruthy();
  });

  it("does not show exit code when PTY is active", async () => {
    const payload = makePayload();
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("PTY Diagnostics")).toBeTruthy();
    });

    expect(screen.queryByText("Exit Code")).toBeNull();
  });

  it("omits TTY row when ptyTty is undefined", async () => {
    const payload = makePayload({ ptyTty: undefined });
    dispatchMock.mockResolvedValue({ ok: true, result: payload });

    render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);

    await waitFor(() => {
      expect(screen.getByText("PTY Diagnostics")).toBeTruthy();
    });

    expect(screen.queryByText("TTY Device")).toBeNull();
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

    const user = userEvent.setup();
    await user.click(screen.getByText("Copy to Clipboard"));

    expect(writeTextMock).toHaveBeenCalledOnce();
    const clipboardText = writeTextMock.mock.calls[0][0] as string;
    expect(clipboardText).toContain("PTY Diagnostics:");
    expect(clipboardText).toContain("Shell PID: 12345");
    expect(clipboardText).toContain("TTY Device: /dev/ttys004");
    expect(clipboardText).toContain("Foreground Process: vim");
    expect(clipboardText).toContain("Dimensions: 80 × 24");
  });
});
