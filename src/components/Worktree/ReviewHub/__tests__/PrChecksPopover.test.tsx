/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";

const getChecksMock = vi.fn();
const openSendToAgentMock = vi.fn();

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { getChecks: (cwd: string, prNumber: number) => getChecksMock(cwd, prNumber) },
}));

vi.mock("@/hooks/useSendToAgentPalette", () => ({
  openSendToAgentPaletteWithText: (text: string, sourceTerminalId?: string) =>
    openSendToAgentMock(text, sourceTerminalId) as boolean,
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
  vi.useRealTimers();
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
        check({ name: "lint", conclusion: "success" }),
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
    expect(rows[2]!.textContent).toContain("lint");
    expect(rows[2]!.textContent).toContain("Passed");
    // Requiredness is only claimed where the provider reported it.
    expect(rows[2]!.textContent).not.toContain("Required");
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

    getChecksMock.mockResolvedValue({ checks: [check()] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("pr-checks-list");
    expect(getChecksMock).toHaveBeenCalledTimes(2);
  });

  it("re-reads on Refresh and on every reopening", async () => {
    getChecksMock.mockResolvedValue({ checks: [check()] });
    renderPopover();
    await openAndSettle();
    await screen.findByTestId("pr-checks-list");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getChecksMock).toHaveBeenCalledTimes(2));

    fireEvent.click(trigger());
    await waitFor(() => expect(screen.queryByTestId("pr-checks-list")).toBeNull());
    fireEvent.click(trigger());
    await waitFor(() => expect(getChecksMock).toHaveBeenCalledTimes(3));
  });

  it("shows no loader before the Doherty threshold, then a skeleton", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolve!: (value: { checks: ForgeCheckRun[] }) => void;
    getChecksMock.mockReturnValue(
      new Promise<{ checks: ForgeCheckRun[] }>((r) => {
        resolve = r;
      })
    );
    renderPopover();
    fireEvent.click(trigger());

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByLabelText("Loading CI checks")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByLabelText("Loading CI checks")).toBeTruthy();

    await act(async () => {
      resolve({ checks: [check()] });
    });
    await screen.findByTestId("pr-checks-list");
  });

  it("lets a stale read lose to a newer one", async () => {
    let resolveFirst!: (value: { checks: ForgeCheckRun[] }) => void;
    getChecksMock.mockReturnValueOnce(
      new Promise<{ checks: ForgeCheckRun[] }>((r) => {
        resolveFirst = r;
      })
    );
    renderPopover();
    fireEvent.click(trigger());
    await waitFor(() => expect(getChecksMock).toHaveBeenCalledTimes(1));

    // Second opening supersedes the first read…
    fireEvent.click(trigger());
    getChecksMock.mockResolvedValue({ checks: [check({ name: "fresh", conclusion: "failure" })] });
    fireEvent.click(trigger());
    await screen.findByText("fresh");

    // …and the abandoned one must not paint over it.
    await act(async () => {
      resolveFirst({ checks: [check({ name: "stale" })] });
    });
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("fresh")).toBeTruthy();
  });

  it("survives a read that resolves after unmount", async () => {
    let resolve!: (value: { checks: ForgeCheckRun[] }) => void;
    getChecksMock.mockReturnValue(
      new Promise<{ checks: ForgeCheckRun[] }>((r) => {
        resolve = r;
      })
    );
    const { unmount } = renderPopover();
    fireEvent.click(trigger());
    await waitFor(() => expect(getChecksMock).toHaveBeenCalled());
    unmount();
    await act(async () => {
      resolve({ checks: [check()] });
    });
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

  it("marks its content so the hub's Escape handler can stand aside", async () => {
    getChecksMock.mockResolvedValue({ checks: [check()] });
    renderPopover();
    await openAndSettle();
    await screen.findByTestId("pr-checks-list");

    const content = document.querySelector('[data-pr-checks-popover][data-state="open"]');
    expect(content).not.toBeNull();
  });
});
