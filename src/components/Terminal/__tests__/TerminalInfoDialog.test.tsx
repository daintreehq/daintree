// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalInfoDialog } from "../TerminalInfoDialog";
import type { TerminalInfoPayload } from "@/types/electron";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const dispatchMock = vi.fn();
let mockPanelsById: Record<string, unknown> = {};

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
    selector({ panelsById: mockPanelsById }),
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
    analysisEnabled: true,
    kind: "terminal",
    shell: "/bin/zsh",
    ptyCols: 80,
    ptyRows: 24,
    ptyPid: 12345,
    ptyForegroundProcess: "vim",
    ptyTty: "/dev/ttys004",
    ...overrides,
  };
}

function renderDialog() {
  return render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="test-id" />);
}

async function copyPayload(): Promise<string> {
  const writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: writeTextMock } });
  const button = await screen.findByRole("button", { name: "Copy diagnostics" });
  fireEvent.click(button);
  await waitFor(() => expect(writeTextMock).toHaveBeenCalledOnce());
  return String(writeTextMock.mock.calls[0]![0]);
}

/**
 * Assert an element is actually presented, not merely mounted.
 *
 * `getByTestId` returns elements inside a `hidden` subtree, so an assertion built on it
 * alone passes against a body that renders and is then hidden — which is exactly the
 * shape of the defect these tests exist to catch.
 */
function expectPresented(el: HTMLElement): void {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    expect(node.hasAttribute("hidden")).toBe(false);
    expect(node.style.display).not.toBe("none");
  }
}

/** Every label rendered in the body, in DOM order. */
function labelsInOrder(): string[] {
  const body = screen.getByTestId("terminal-info-body");
  return Array.from(body.querySelectorAll("dt")).map((el) => el.textContent ?? "");
}

describe("TerminalInfoDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPanelsById = {};
  });

  describe("hierarchy", () => {
    // The rule, not the labels: whatever the overview and the deep diagnostics end up
    // being called, liveness must not sit below the low-frequency internals. This is
    // the whole point of #11978 and it is the thing a future round is most likely to
    // undo by adding "just one more" row to the top.
    it("puts the liveness overview ahead of every deep-diagnostic row", async () => {
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
      renderDialog();

      const body = await screen.findByTestId("terminal-info-body");
      const overview = screen.getByTestId("terminal-info-overview");
      const disclosureToggles = screen.getAllByRole("button", { expanded: false });

      expect(disclosureToggles.length).toBeGreaterThan(0);
      for (const toggle of disclosureToggles) {
        expect(
          overview.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
      }
      expect(body.contains(overview)).toBe(true);
    });

    // Arriving on the first control would scroll the body past the overview, since
    // every control sits below it. Focus has to start inside what is read first.
    it("arrives inside the overview, not on a control below it", async () => {
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
      renderDialog();

      const overview = await screen.findByTestId("terminal-info-overview");
      await waitFor(() => expect(overview.contains(document.activeElement)).toBe(true));
    });

    it("keeps the deep diagnostics collapsed until asked for", async () => {
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
      renderDialog();

      const toggles = await screen.findAllByRole("button", { expanded: false });
      for (const toggle of toggles) {
        const panelId = toggle.getAttribute("aria-controls");
        expect(panelId).toBeTruthy();
        const region = document.getElementById(panelId!);
        // The disclosure contract: the toggle names a real region, and that region is
        // hidden while the toggle reports collapsed.
        expect(region).toBeTruthy();
        expect(region!.hasAttribute("hidden")).toBe(true);
      }

      fireEvent.click(toggles[0]!);
      const panelId = toggles[0]!.getAttribute("aria-controls")!;
      expect(document.getElementById(panelId)!.hasAttribute("hidden")).toBe(false);
      expect(toggles[0]!.getAttribute("aria-expanded")).toBe("true");
    });
  });

  describe("positional memory", () => {
    // A properties sheet is scanned by position. If a row vanishes when its value is
    // absent, the reader's memory of "PID is the second row" is wrong on the next
    // terminal — so within a group every row renders whether or not it has a value.
    it("renders the same rows for a sparse payload as for a populated one", async () => {
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
      const populated = renderDialog();
      await screen.findByTestId("terminal-info-body");
      const populatedLabels = labelsInOrder();
      populated.unmount();

      dispatchMock.mockResolvedValue({
        ok: true,
        result: makePayload({
          ptyPid: undefined,
          ptyCols: undefined,
          ptyRows: undefined,
          ptyForegroundProcess: undefined,
          ptyTty: undefined,
          shell: undefined,
          spawnArgs: undefined,
        }),
      });
      renderDialog();
      await screen.findByTestId("terminal-info-body");

      expect(labelsInOrder()).toEqual(populatedLabels);
    });

    it("distinguishes a field that does not apply from one it could not read", async () => {
      dispatchMock.mockResolvedValue({
        ok: true,
        result: makePayload({ ptyPid: undefined, spawnArgs: [] }),
      });
      renderDialog();
      await screen.findByTestId("terminal-info-body");

      fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]!);

      const body = screen.getByTestId("terminal-info-body");
      const cells = Array.from(body.querySelectorAll("dd")).map((el) => el.textContent ?? "");
      // Unreadable telemetry and an empty-but-known list must not share one word.
      expect(cells).toContain("Unavailable");
      expect(cells.some((text) => text.includes("—"))).toBe(true);
    });
  });

  describe("an exited terminal", () => {
    // The defect this whole run was worth doing for. A terminal preserved after a
    // non-zero exit has no PTY record left in the host, so `terminal.info.get` throws
    // — and the dialog used to answer with nothing but that error, on precisely the
    // terminal someone opened it to debug.
    it("still renders an inspector when the live read fails", async () => {
      mockPanelsById = {
        "test-id": {
          id: "test-id",
          kind: "terminal",
          title: "build worker",
          cwd: "/repo/apps/worker",
          location: "grid",
          runtimeStatus: "exited",
          exitCode: 3,
          spawnStatus: "ready",
        },
      };
      dispatchMock.mockResolvedValue({
        ok: false,
        error: { message: "Failed to get terminal info: Terminal test-id not found" },
      });

      renderDialog();

      await screen.findByTestId("terminal-info-error");
      // The body survives the failure, and the exit code — the single most useful fact
      // about a dead terminal — is on screen.
      expectPresented(screen.getByTestId("terminal-info-body"));
      const liveness = screen.getByTestId("terminal-info-liveness");
      expectPresented(liveness);
      expect(liveness.textContent).toContain("3");
      expectPresented(screen.getByText("build worker"));
      expectPresented(screen.getByText("/repo/apps/worker"));
    });

    it("reports liveness from the runtime status, not the spawn status", async () => {
      // `spawnStatus` is live-only spawn-lifecycle state that stays "ready" forever
      // after a successful spawn; `runtimeStatus` is the store's authoritative
      // liveness signal. Reading the wrong one told the user a dead terminal was fine.
      mockPanelsById = {
        "test-id": {
          id: "test-id",
          kind: "terminal",
          runtimeStatus: "exited",
          spawnStatus: "ready",
          exitCode: 0,
        },
      };
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload({ hasPty: true }) });

      renderDialog();
      await screen.findByTestId("terminal-info-body");

      const livenessEl = screen.getByTestId("terminal-info-liveness");
      expectPresented(livenessEl);
      const liveness = livenessEl.textContent ?? "";
      expect(liveness).toContain("Exited");
      expect(liveness).not.toContain("ready");
    });

    it("reports a live terminal as running", async () => {
      mockPanelsById = { "test-id": { id: "test-id", kind: "terminal", runtimeStatus: "active" } };
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });

      renderDialog();
      await screen.findByTestId("terminal-info-body");

      expect(screen.getByTestId("terminal-info-liveness").textContent).toBe("Running");
    });

    it("offers a retry that re-issues the read", async () => {
      dispatchMock.mockResolvedValue({ ok: false, error: { message: "pty host is gone" } });
      renderDialog();
      await screen.findByTestId("terminal-info-error");
      const callsBefore = dispatchMock.mock.calls.length;

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => expect(dispatchMock.mock.calls.length).toBeGreaterThan(callsBefore));
    });
  });

  describe("the copied payload", () => {
    it("stays complete when the deep diagnostics are collapsed", async () => {
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
      renderDialog();
      await screen.findByTestId("terminal-info-body");

      // Nothing expanded — the collapsed rows must still reach the clipboard.
      expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0);

      const text = await copyPayload();
      expect(text).toContain("Shell PID: 12345");
      expect(text).toContain("TTY device: /dev/ttys004");
      expect(text).toContain("Dimensions: 80 × 24");
      expect(text).toContain("Output buffer: 100 lines");
    });

    it("carries the panel-store facts when the live read failed", async () => {
      mockPanelsById = {
        "test-id": {
          id: "test-id",
          kind: "terminal",
          title: "build worker",
          cwd: "/repo/apps/worker",
          runtimeStatus: "exited",
          exitCode: 3,
          spawnedBy: "mcp",
        },
      };
      dispatchMock.mockResolvedValue({ ok: false, error: { message: "Terminal not found" } });

      renderDialog();
      await screen.findByTestId("terminal-info-error");

      const text = await copyPayload();
      expect(text).toContain("Exit code: 3");
      expect(text).toContain("build worker");
      expect(text).toContain("/repo/apps/worker");
      // And it says so, rather than presenting a half-payload as complete.
      expect(text).toContain("could not be read");
    });

    it("names the assistant and the transport separately (#11808)", async () => {
      mockPanelsById = { "test-id": { id: "test-id", kind: "terminal", spawnedBy: "assistant" } };
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });

      renderDialog();
      await screen.findByTestId("terminal-info-body");

      // Two facts, not one: the actor and the fact it was still an MCP dispatch.
      expect(screen.getByText("Daintree Assistant")).toBeTruthy();
      const text = await copyPayload();
      expect(text).toContain("Started by: Daintree Assistant");
      expect(text).toContain("Started via MCP: Yes");
    });

    it("omits the initiator row for external MCP and user-started runs (#11808)", async () => {
      mockPanelsById = { "test-id": { id: "test-id", kind: "terminal", spawnedBy: "mcp" } };
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });

      renderDialog();
      await screen.findByTestId("terminal-info-body");

      expect(screen.queryByText("Daintree Assistant")).toBeNull();
      const text = await copyPayload();
      expect(text).toContain("Started via MCP: Yes");
      expect(text).not.toContain("Started by:");
    });
  });

  describe("agent sections", () => {
    it("shows launch context and live state for an agent terminal", async () => {
      dispatchMock.mockResolvedValue({
        ok: true,
        result: makePayload({
          launchAgentId: "claude",
          detectedAgentId: "claude",
          agentState: "working",
          agentLaunchFlags: ["--verbose"],
          agentModelId: "claude-opus-4-6",
        }),
      });

      renderDialog();
      expect(await screen.findByText("--verbose")).toBeTruthy();
      expect(screen.getByText("claude-opus-4-6")).toBeTruthy();
      const overview = screen.getByTestId("terminal-info-overview");
      // The agent and its state belong in the overview, not four sections down.
      expect(within(overview).getByText(/working/)).toBeTruthy();
    });

    it("omits both agent sections for a terminal that never saw an agent", async () => {
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
      renderDialog();
      await screen.findByTestId("terminal-info-body");

      const labels = labelsInOrder();
      expect(labels).not.toContain("Launch agent");
      expect(labels).not.toContain("Detected agent");
    });

    it("reports an agent that has exited rather than one that never started", async () => {
      dispatchMock.mockResolvedValue({
        ok: true,
        result: makePayload({ detectedAgentId: undefined, everDetectedAgent: true }),
      });

      renderDialog();
      // The body renders before `terminal.info.get` resolves, so wait for the
      // fetched value itself rather than the container.
      expect(await screen.findByText("Agent has exited")).toBeTruthy();
    });
  });

  describe("between openings", () => {
    // The rule: an opening never inherits another opening's disclosure state. The
    // flags used to outlive the dialog, so one look at a terminal's internals left
    // them expanded on every terminal inspected afterwards.
    it("starts every opening and every terminal with the disclosures collapsed", async () => {
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
      const onClose = vi.fn();
      const view = render(<TerminalInfoDialog isOpen={true} onClose={onClose} terminalId="a" />);
      await screen.findByTestId("terminal-info-body");
      const expandAll = () => {
        for (const toggle of screen.getAllByRole("button", { expanded: false })) {
          fireEvent.click(toggle);
        }
      };
      const expandedCount = () => screen.queryAllByRole("button", { expanded: true }).length;

      expandAll();
      expect(expandedCount()).toBeGreaterThan(0);

      view.rerender(<TerminalInfoDialog isOpen={true} onClose={onClose} terminalId="b" />);
      await waitFor(() => expect(expandedCount()).toBe(0));

      expandAll();
      view.rerender(<TerminalInfoDialog isOpen={false} onClose={onClose} terminalId="b" />);
      view.rerender(<TerminalInfoDialog isOpen={true} onClose={onClose} terminalId="b" />);
      await screen.findByTestId("terminal-info-body");
      await waitFor(() => expect(expandedCount()).toBe(0));
    });
  });

  describe("absent values", () => {
    // Whatever the vocabulary becomes, an absence is prose and never set in the code
    // face — in mono the same dash rendered as a different glyph on each row.
    it("never sets a fallback in monospace", async () => {
      dispatchMock.mockResolvedValue({
        ok: false,
        error: { message: "Terminal test-id not found" },
      });
      renderDialog();
      await screen.findByTestId("terminal-info-error");
      for (const toggle of screen.getAllByRole("button", { expanded: false })) {
        if (toggle.getAttribute("aria-controls")) fireEvent.click(toggle);
      }

      const absences = new Set(["—", "Unknown", "Unavailable"]);
      const body = screen.getByTestId("terminal-info-body");
      const absent = Array.from(body.querySelectorAll("dd span")).filter((el) =>
        absences.has((el.textContent ?? "").trim())
      );
      expect(absent.length).toBeGreaterThan(0);
      for (const el of absent) expect(el.className).not.toContain("font-mono");
    });

    // A failed read cannot tell us argv was empty, so it must not say "not applicable".
    it("reports arguments it could not read as unavailable", async () => {
      dispatchMock.mockResolvedValue({ ok: false, error: { message: "not found" } });
      renderDialog();
      await screen.findByTestId("terminal-info-error");

      const argsLabel = within(screen.getByTestId("terminal-info-body")).getByText("Arguments");
      expect(argsLabel.nextElementSibling?.textContent).toBe("Unavailable");
    });

    // Rows the panel store owns are already final; a skeleton on one promises a value
    // the host read can never deliver.
    it("never skeletons a row the host read cannot fill", async () => {
      mockPanelsById = {
        "test-id": { id: "test-id", kind: "terminal", title: "t", cwd: "/r", location: "grid" },
      };
      dispatchMock.mockReturnValue(new Promise(() => {}));
      renderDialog();
      const body = await screen.findByTestId("terminal-info-body");

      for (const label of ["Spawn source", "Started via MCP", "Created"]) {
        const dd = within(body).getByText(label).nextElementSibling as HTMLElement;
        expect(dd.querySelector('[data-testid="terminal-info-pending"]')).toBeNull();
      }
      expect(screen.getByTestId("terminal-info-loading-status").textContent).not.toBe("");
    });
  });

  describe("an agent that left a live shell", () => {
    // The terminal is alive; the agent is not. The process row must name what is in
    // the foreground now, not only the agent that left.
    it("names the foreground process, not just the departed agent", async () => {
      mockPanelsById = {
        "test-id": {
          id: "test-id",
          kind: "terminal",
          title: "Claude",
          cwd: "/r",
          location: "grid",
          launchAgentId: "claude",
          runtimeStatus: "running",
        },
      };
      dispatchMock.mockResolvedValue({
        ok: true,
        result: makePayload({
          launchAgentId: "claude",
          agentState: "exited",
          ptyForegroundProcess: "zsh",
        }),
      });
      renderDialog();
      const overview = await screen.findByTestId("terminal-info-overview");
      const processCell = await waitFor(() => {
        const dd = within(overview).getByText("Process").nextElementSibling;
        expect(dd?.textContent).toContain("zsh");
        return dd!;
      });
      expect(screen.getByTestId("terminal-info-liveness").textContent).toBe("Running");
      expect(processCell.textContent).toMatch(/exited/);
    });
  });

  describe("the copied payload, beyond what is on screen", () => {
    // The synchronised-output row lives in a disclosure that polls only while open;
    // the payload must read it regardless, or a collapsed copy reports it unknowable.
    it("reads synchronized output even while Performance is collapsed", async () => {
      const spy = vi
        .spyOn(terminalInstanceService, "getSynchronizedOutputMode")
        .mockReturnValue(true);
      dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
      renderDialog();
      await screen.findByText("vim");

      expect(await copyPayload()).toMatch(/Synchronized output \(DEC 2026\): On/);
      spy.mockRestore();
    });

    // argv boundaries survive the copy: two arguments are never one string.
    it("serializes argv without losing argument boundaries", async () => {
      dispatchMock.mockResolvedValue({
        ok: true,
        result: makePayload({ spawnArgs: ["-c", "echo a b"] }),
      });
      renderDialog();
      await screen.findByText("echo a b");

      expect(await copyPayload()).toContain('Args: ["-c","echo a b"]');
    });
  });

  describe("data identity and freshness", () => {
    // Host data belongs to the terminal it was read for. Retargeting the open dialog
    // must never show the previous terminal's host values under the new title.
    it("never shows one terminal's host data under another", async () => {
      dispatchMock.mockResolvedValueOnce({
        ok: true,
        result: makePayload({ ptyForegroundProcess: "first-terminal-proc" }),
      });
      const view = render(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="a" />);
      expect(await screen.findByText("first-terminal-proc")).toBeTruthy();

      dispatchMock.mockReturnValue(new Promise(() => {}));
      view.rerender(<TerminalInfoDialog isOpen={true} onClose={vi.fn()} terminalId="b" />);
      expect(screen.queryByText("first-terminal-proc")).toBeNull();
    });

    // A background read that comes back empty is a lost record, not a no-op: the
    // last values must be flagged, never left looking current.
    it("flags values as stale when a refresh finds no record", async () => {
      const getInfo = vi.fn().mockResolvedValue(null);
      vi.stubGlobal("electron", { terminal: { getInfo } });
      try {
        dispatchMock.mockResolvedValue({ ok: true, result: makePayload() });
        renderDialog();
        await screen.findByText("vim");

        const banner = await screen.findByTestId("terminal-info-error", {}, { timeout: 4000 });
        expect(getInfo).toHaveBeenCalled();
        expect(banner.textContent).toMatch(/last successful read/);
        expect(await copyPayload()).toMatch(/NOTE: the terminal host stopped answering/);
      } finally {
        vi.unstubAllGlobals();
        vi.stubGlobal(
          "ResizeObserver",
          class {
            observe() {}
            unobserve() {}
            disconnect() {}
          }
        );
      }
    });

    // A report copied mid-load says it was loading, not that the read failed.
    it("reports a copy taken during loading as loading", async () => {
      dispatchMock.mockReturnValue(new Promise(() => {}));
      renderDialog();
      await screen.findByTestId("terminal-info-body");

      const payload = await copyPayload();
      expect(payload).toMatch(/still loading/);
      expect(payload).not.toMatch(/could not be read/);
    });
  });
});
