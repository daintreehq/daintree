/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";

const getChecksMock = vi.fn();
// Typed rather than bare `vi.fn()`: an untyped mock returns `any`, and the cast
// back at the call site is exactly what `no-unsafe-type-assertion` flags.
const openSendToAgentMock = vi.fn<(text: string, sourceTerminalId?: string) => boolean>();

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { getChecks: (cwd: string, prNumber: number) => getChecksMock(cwd, prNumber) },
}));

vi.mock("@/hooks/useSendToAgentPalette", () => ({
  openSendToAgentPaletteWithText: (text: string, sourceTerminalId?: string) =>
    openSendToAgentMock(text, sourceTerminalId),
}));

import { PrChecksPopover } from "../PrChecksPopover";

class StubResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  getChecksMock.mockReset();
  openSendToAgentMock.mockReset();
  openSendToAgentMock.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const check = (overrides: Partial<ForgeCheckRun> = {}): ForgeCheckRun => ({
  name: "build",
  status: "completed",
  conclusion: "success",
  ...overrides,
});

const onOpenExternal = vi.fn();

function renderPopover(props: Partial<React.ComponentProps<typeof PrChecksPopover>> = {}) {
  onOpenExternal.mockReset();
  return render(
    <PrChecksPopover
      worktreePath="/tmp/wt"
      prNumber={42}
      prUrl="https://github.com/o/r/pull/42"
      triggerLabel="Pull request #42 open — CI failing. Show CI checks"
      onOpenExternal={onOpenExternal}
      {...props}
    >
      <span>#42</span>
    </PrChecksPopover>
  );
}

const trigger = () => screen.getByTestId("pr-checks-trigger");

/** Open the disclosure and let the mocked read settle. */
async function openAndSettle() {
  fireEvent.click(trigger());
  await waitFor(() => expect(getChecksMock).toHaveBeenCalled());
}

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PrChecksPopover", () => {
  it("reads nothing until the disclosure is opened", async () => {
    renderPopover();
    fireEvent.pointerEnter(trigger());
    fireEvent.focus(trigger());
    // A beat for any stray effect to fire.
    await Promise.resolve();
    expect(getChecksMock).not.toHaveBeenCalled();
  });

  it("reads the checks for this worktree and PR on open", async () => {
    getChecksMock.mockResolvedValue({ checks: [check()] });
    renderPopover();
    await openAndSettle();
    expect(getChecksMock).toHaveBeenCalledWith("/tmp/wt", 42);
    await screen.findByTestId("pr-checks-list");
  });

  it("lists every check with its name, outcome and requiredness", async () => {
    getChecksMock.mockResolvedValue({
      checks: [
        check({ name: "lint", conclusion: "success", required: false }),
        check({ name: "build", conclusion: "failure", required: true }),
        check({ name: "e2e", status: "in_progress", conclusion: undefined }),
      ],
    });
    renderPopover();
    await openAndSettle();

    const list = await screen.findByTestId("pr-checks-list");
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(3);
    // Failures lead.
    expect(rows[0]!.textContent).toContain("build");
    expect(rows[0]!.textContent).toContain("Failed · Required");
    expect(rows[1]!.textContent).toContain("e2e");
    expect(rows[1]!.textContent).toContain("Running");
    // Known-optional and unknown-requiredness must not read alike.
    expect(rows[2]!.textContent).toContain("Passed · Not required");
    expect(rows[1]!.textContent).not.toMatch(/required/i);
  });

  it("routes a validated details link through the external opener", async () => {
    getChecksMock.mockResolvedValue({
      checks: [
        check({
          name: "build",
          conclusion: "failure",
          detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
        }),
      ],
    });
    renderPopover();
    await openAndSettle();

    fireEvent.click(await screen.findByRole("button", { name: /open details for build/i }));
    expect(onOpenExternal).toHaveBeenCalledWith("https://github.com/o/r/actions/runs/1/job/2");
  });

  it("distinguishes two matrix shards that share a name", async () => {
    getChecksMock.mockResolvedValue({
      checks: [
        check({ name: "test", conclusion: "success", detailsUrl: "https://e.com/a" }),
        check({ name: "test", conclusion: "failure", detailsUrl: "https://e.com/b" }),
      ],
    });
    renderPopover();
    await openAndSettle();
    await screen.findByTestId("pr-checks-list");

    // Tabbing between the two link buttons must not meet the same name twice.
    const names = screen
      .getAllByRole("button", { name: /open details for test/i })
      .map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
  });

  it("offers no link at all for a details URL it cannot validate", async () => {
    getChecksMock.mockResolvedValue({
      checks: [check({ name: "build", conclusion: "failure", detailsUrl: "javascript:alert(1)" })],
    });
    renderPopover();
    await openAndSettle();

    await screen.findByTestId("pr-checks-list");
    expect(screen.queryByRole("button", { name: /open details for/i })).toBeNull();
  });

  it("keeps the three provider outcomes apart — no checks is not the same as no PR", async () => {
    getChecksMock.mockResolvedValue({ checks: [] });
    const { unmount } = renderPopover();
    await openAndSettle();
    expect((await screen.findByTestId("pr-checks-empty")).textContent).toContain(
      "No CI checks reported"
    );
    unmount();
    cleanup();

    getChecksMock.mockReset();
    getChecksMock.mockResolvedValue(null);
    renderPopover();
    await openAndSettle();
    expect((await screen.findByTestId("pr-checks-missing")).textContent).toContain("wasn't found");
  });

  it("degrades a failed read to an inline retry, never a toast", async () => {
    getChecksMock.mockRejectedValueOnce(new Error("offline"));
    renderPopover();
    await openAndSettle();

    const notice = await screen.findByTestId("pr-checks-error");
    expect(notice.textContent).toContain("Couldn't load checks.");

    const reload = screen.getByTestId("pr-checks-reload");
    // `Retry` for a failure, `Refresh` for a re-read — see user-signals.md.
    expect(reload.textContent).toBe("Retry");

    getChecksMock.mockResolvedValue({ checks: [check()] });
    fireEvent.click(reload);
    await screen.findByTestId("pr-checks-list");
    expect(getChecksMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("pr-checks-reload").textContent).toBe("Refresh");
  });

  it("keeps the reload control mounted across the read it started", async () => {
    // Unmounting it would drop a keyboard user's focus onto document.body
    // inside an open popover, with nothing to tab back to.
    const first = deferred<{ checks: ForgeCheckRun[] }>();
    getChecksMock.mockReturnValueOnce(first.promise);
    renderPopover();
    fireEvent.click(trigger());
    await act(async () => {
      first.resolve({ checks: [check()] });
    });
    await screen.findByTestId("pr-checks-list");

    const reload = screen.getByTestId("pr-checks-reload");
    reload.focus();
    const pending = deferred<{ checks: ForgeCheckRun[] }>();
    getChecksMock.mockReturnValueOnce(pending.promise);
    fireEvent.click(reload);

    expect(document.activeElement).toBe(reload);
    await act(async () => {
      pending.resolve({ checks: [check()] });
    });
    expect(document.activeElement).toBe(screen.getByTestId("pr-checks-reload"));
  });

  it("replaces the previous snapshot on reload rather than merging into it", async () => {
    getChecksMock.mockResolvedValueOnce({ checks: [check({ name: "old" })] });
    renderPopover();
    await openAndSettle();
    await screen.findByText("old");

    getChecksMock.mockResolvedValueOnce({ checks: [check({ name: "new" })] });
    fireEvent.click(screen.getByTestId("pr-checks-reload"));
    await screen.findByText("new");
    expect(screen.queryByText("old")).toBeNull();
  });

  it("re-reads on every reopening", async () => {
    getChecksMock.mockResolvedValue({ checks: [check()] });
    renderPopover();
    await openAndSettle();
    await screen.findByTestId("pr-checks-list");

    fireEvent.click(trigger());
    await waitFor(() => expect(screen.queryByTestId("pr-checks-list")).toBeNull());
    fireEvent.click(trigger());
    await waitFor(() => expect(getChecksMock).toHaveBeenCalledTimes(2));
  });

  it("shows no loader before the Doherty threshold, then a skeleton that does not flash", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pending = deferred<{ checks: ForgeCheckRun[] }>();
      getChecksMock.mockReturnValue(pending.promise);
      renderPopover();
      fireEvent.click(trigger());

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByTestId("pr-checks-skeleton")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByTestId("pr-checks-skeleton")).toBeTruthy();

      // Resolving immediately after onset must not tear the skeleton down in
      // the same frame — the display floor holds it.
      await act(async () => {
        pending.resolve({ checks: [check()] });
      });
      expect(screen.getByTestId("pr-checks-skeleton")).toBeTruthy();
      // The floor means holding the placeholder, not stacking it on the results.
      expect(screen.queryByTestId("pr-checks-list")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      await screen.findByTestId("pr-checks-list");

      // Let Radix's deferred teardown run while the fake clock is still
      // installed, so nothing is abandoned mid-flight.
      cleanup();
      await act(async () => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a stale read lose to a newer one", async () => {
    const first = deferred<{ checks: ForgeCheckRun[] }>();
    getChecksMock.mockReturnValueOnce(first.promise);
    renderPopover();
    fireEvent.click(trigger());
    await waitFor(() => expect(getChecksMock).toHaveBeenCalledTimes(1));

    // Second click closes and invalidates the first read…
    fireEvent.click(trigger());
    getChecksMock.mockResolvedValue({ checks: [check({ name: "fresh", conclusion: "failure" })] });
    // …the third reopens and starts a new one.
    fireEvent.click(trigger());
    await screen.findByText("fresh");

    // The abandoned read must not paint over it.
    await act(async () => {
      first.resolve({ checks: [check({ name: "stale" })] });
    });
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("fresh")).toBeTruthy();
  });

  it("lets a stale rejection lose too", async () => {
    // The rejection arm carries its own guard; a fresh success must survive it.
    const first = deferred<{ checks: ForgeCheckRun[] }>();
    getChecksMock.mockReturnValueOnce(first.promise);
    renderPopover();
    fireEvent.click(trigger());
    await waitFor(() => expect(getChecksMock).toHaveBeenCalledTimes(1));

    getChecksMock.mockResolvedValue({ checks: [check({ name: "fresh" })] });
    fireEvent.click(screen.getByTestId("pr-checks-reload"));
    await screen.findByText("fresh");

    await act(async () => {
      first.reject(new Error("too late"));
    });
    expect(screen.queryByTestId("pr-checks-error")).toBeNull();
    expect(screen.getByText("fresh")).toBeTruthy();
  });

  it("survives a read that resolves after unmount", async () => {
    const pending = deferred<{ checks: ForgeCheckRun[] }>();
    getChecksMock.mockReturnValue(pending.promise);
    const { unmount } = renderPopover();
    fireEvent.click(trigger());
    await waitFor(() => expect(getChecksMock).toHaveBeenCalled());
    unmount();
    await act(async () => {
      pending.resolve({ checks: [check()] });
    });
  });

  it("closes itself on Escape and hands focus back to the trigger", async () => {
    getChecksMock.mockResolvedValue({ checks: [check()] });
    renderPopover();
    await openAndSettle();
    await screen.findByTestId("pr-checks-list");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("pr-checks-list")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("marks the trigger while open so the hub's Escape handler can stand aside", async () => {
    getChecksMock.mockResolvedValue({ checks: [check()] });
    renderPopover();
    expect(trigger().getAttribute("data-pr-checks-open")).toBeNull();

    await openAndSettle();
    await screen.findByTestId("pr-checks-list");
    // The marker is on the trigger, not the portalled content: before Radix has
    // loaded there is no content, and the hub would close instead.
    expect(document.querySelector('[data-pr-checks-open="true"]')).toBe(trigger());
  });

  it("hands the failing checks to the existing palette and closes", async () => {
    getChecksMock.mockResolvedValue({
      checks: [
        check({ name: "lint", conclusion: "success" }),
        check({
          name: "build",
          conclusion: "failure",
          required: true,
          detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
        }),
      ],
    });
    renderPopover();
    await openAndSettle();

    fireEvent.click(await screen.findByTestId("pr-checks-send"));
    expect(openSendToAgentMock).toHaveBeenCalledTimes(1);

    const [text, sourceTerminalId] = openSendToAgentMock.mock.calls[0]!;
    // The Review Hub is not a terminal, so nothing may be excluded as the source.
    expect(sourceTerminalId).toBeUndefined();
    expect(text).toContain("pull request #42");
    expect(text).toContain("build");
    expect(text).not.toContain("lint");

    await waitFor(() => expect(screen.queryByTestId("pr-checks-list")).toBeNull());
  });

  it("leaves focus with the palette instead of clawing it back to the trigger", async () => {
    const palette = document.createElement("input");
    document.body.appendChild(palette);
    openSendToAgentMock.mockImplementation(() => {
      palette.focus();
      return true;
    });
    getChecksMock.mockResolvedValue({ checks: [check({ conclusion: "failure" })] });
    renderPopover();
    await openAndSettle();

    fireEvent.click(await screen.findByTestId("pr-checks-send"));
    await waitFor(() => expect(screen.queryByTestId("pr-checks-list")).toBeNull());
    // Radix defers close-autofocus; the suppression is what stops it landing
    // on the trigger a frame after the palette took focus.
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(palette);
    palette.remove();
  });

  it("offers no hand-off when nothing is failing", async () => {
    getChecksMock.mockResolvedValue({ checks: [check({ conclusion: "success" })] });
    renderPopover();
    await openAndSettle();
    await screen.findByTestId("pr-checks-list");
    expect(screen.queryByTestId("pr-checks-send")).toBeNull();
  });

  it("stays open and says why when there is no agent to send to", async () => {
    openSendToAgentMock.mockReturnValue(false);
    getChecksMock.mockResolvedValue({ checks: [check({ conclusion: "failure" })] });
    renderPopover();
    await openAndSettle();

    fireEvent.click(await screen.findByTestId("pr-checks-send"));
    expect((await screen.findByTestId("pr-checks-send-hint")).textContent).toContain(
      "Open an agent terminal"
    );
    expect(screen.getByTestId("pr-checks-list")).toBeTruthy();
  });

  it("keeps every row of a large check list", async () => {
    getChecksMock.mockResolvedValue({
      checks: Array.from({ length: 300 }, (_, i) =>
        check({ name: `job-${i}`, conclusion: i === 297 ? "failure" : "success" })
      ),
    });
    renderPopover();
    await openAndSettle();

    const list = await screen.findByTestId("pr-checks-list");
    expect(list.querySelectorAll("li")).toHaveLength(300);
    expect(list.querySelectorAll("li")[0]!.textContent).toContain("job-297");
  });
});
