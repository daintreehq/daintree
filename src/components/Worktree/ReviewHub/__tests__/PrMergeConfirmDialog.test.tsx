/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import type { PR } from "@shared/types/forge";

const getPRMock =
  vi.fn<(cwd: string, prNumber: number, options?: { fresh?: boolean }) => Promise<PR | null>>();
const dispatchMock =
  vi.fn<
    (
      id: string,
      args: unknown,
      options: unknown
    ) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>
  >();
const refreshMock = vi.fn<() => Promise<void>>();

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    getPR: (cwd: string, prNumber: number, options?: { fresh?: boolean }) =>
      getPRMock(cwd, prNumber, options),
  },
}));
vi.mock("@/clients", () => ({
  worktreeClient: { refreshPullRequests: () => refreshMock() },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (id: string, args: unknown, options: unknown) => dispatchMock(id, args, options),
  },
}));

import { PrMergeConfirmDialog } from "../PrMergeConfirmDialog";

class StubResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const HEAD = "abcdef1".padEnd(40, "0");

function pr(overrides: Partial<PR> = {}): PR {
  return {
    number: 42,
    title: "t",
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: "https://github.com/acme/widgets/pull/42",
    baseRef: "develop",
    headRef: "feature/x",
    createdAt: 0,
    updatedAt: 0,
    mergeStatus: "blocked",
    mergeIntent: null,
    mergeQueueRequired: false,
    headSha: HEAD,
    commits: { totalCount: 1, items: [{ sha: HEAD, subject: "Add the thing", author: "dev" }] },
    rawData: null,
    ...overrides,
  };
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  getPRMock.mockReset();
  dispatchMock.mockReset();
  refreshMock.mockReset();
  refreshMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function isDisabled(el: HTMLElement): boolean {
  return el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
}

/** The confirm carries a read-time cooldown; click once it has elapsed. */
async function clickConfirm(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(isDisabled(button)).toBe(false));
  fireEvent.click(button);
}

type Request = NonNullable<React.ComponentProps<typeof PrMergeConfirmDialog>["request"]>;

/** What the row hands over; only the mode and method vary between these tests. */
function request(overrides: Pick<Request, "mode" | "method"> & Partial<Request>): Request {
  return { title: "Ship it", baseRef: "develop", queue: false, intent: null, ...overrides };
}

function renderDialog(req: Request) {
  const onClose = vi.fn();
  const onComplete = vi.fn();
  render(
    <PrMergeConfirmDialog
      worktreePath="/tmp/wt"
      prNumber={42}
      request={req}
      onClose={onClose}
      onComplete={onComplete}
    />
  );
  return { onClose, onComplete };
}

describe("PrMergeConfirmDialog", () => {
  it("previews what lands and arms pinned to the previewed head", async () => {
    getPRMock.mockResolvedValue(pr());
    dispatchMock.mockResolvedValue({ ok: true, result: { prNumber: 42, outcome: "armed" } });
    const { onClose } = renderDialog(request({ mode: "arm", method: "squash" }));

    await waitFor(() => expect(screen.getByTestId("pr-merge-head").textContent).toBe("abcdef1"));
    expect(screen.getByTestId("pr-merge-base").textContent).toBe("develop");
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(screen.getByTestId("pr-merge-method").textContent).toBe("Squash");
    // The confirm's own read names the PR once it lands, over what the row handed in.
    expect(screen.getByTestId("pr-merge-title").textContent).toBe(pr().title);
    expect(screen.getAllByTestId("pr-merge-commit-row")).toHaveLength(1);
    expect(screen.getByTestId("pr-merge-push-warning").textContent).toMatch(/your own agents/);

    await clickConfirm("Enable auto-merge");

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.enableAutoMerge",
      {
        worktreePath: "/tmp/wt",
        prNumber: 42,
        mergeMethod: "squash",
        expectedHeadSha: HEAD,
        expectedBaseRef: "develop",
      },
      { source: "user" }
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("asks again as a Merge when GitHub declines to arm, and never merges on its own", async () => {
    getPRMock.mockResolvedValueOnce(pr()).mockResolvedValueOnce(pr({ mergeStatus: "clean" }));
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { prNumber: 42, outcome: "already-mergeable", message: "can merge" },
    });
    const { onClose } = renderDialog(request({ mode: "arm", method: "merge" }));

    await waitFor(() => screen.getByTestId("pr-merge-head"));
    await clickConfirm("Enable auto-merge");

    await screen.findByRole("button", { name: "Merge pull request" });
    expect(screen.getByTestId("pr-merge-mode-changed")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls.some(([id]) => id === "forge.mergePR")).toBe(false);

    dispatchMock.mockResolvedValueOnce({ ok: true, result: { prNumber: 42, merged: true } });
    await clickConfirm("Merge pull request");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "forge.mergePR",
      {
        worktreePath: "/tmp/wt",
        prNumber: 42,
        mergeMethod: "merge",
        expectedHeadSha: HEAD,
        expectedBaseRef: "develop",
      },
      { source: "user" }
    );
  });

  it("offers a PR that turned mergeable since the popover as Merge, under a notice", async () => {
    getPRMock.mockResolvedValue(pr({ mergeStatus: "clean" }));
    renderDialog(request({ mode: "arm", method: null }));

    expect(await screen.findByRole("button", { name: "Merge pull request" })).toBeTruthy();
    expect(screen.getByTestId("pr-merge-mode-changed").textContent).toMatch(/can merge now/i);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("names the queue's method rather than inventing one", async () => {
    getPRMock.mockResolvedValue(pr({ mergeQueueRequired: true }));
    dispatchMock.mockResolvedValue({ ok: true, result: { prNumber: 42, outcome: "armed" } });
    renderDialog(request({ mode: "arm", method: "squash" }));

    await waitFor(() =>
      expect(screen.getByTestId("pr-merge-method").textContent).toBe("Set by the merge queue")
    );
    await clickConfirm("Merge when ready");
    await waitFor(() => expect(dispatchMock).toHaveBeenCalled());
    expect(dispatchMock.mock.calls[0]?.[1]).toEqual({
      worktreePath: "/tmp/wt",
      prNumber: 42,
      expectedHeadSha: HEAD,
      expectedBaseRef: "develop",
    });
  });

  it("keeps a rejected write inside the dialog", async () => {
    getPRMock.mockResolvedValue(pr());
    dispatchMock.mockResolvedValue({ ok: false, error: { message: "has new commits" } });
    const { onClose } = renderDialog(request({ mode: "arm", method: "squash" }));

    await waitFor(() => screen.getByTestId("pr-merge-head"));
    await clickConfirm("Enable auto-merge");

    // Plain words up front; GitHub's own text stays available behind the disclosure.
    const notice = await screen.findByTestId("pr-merge-error");
    expect(notice.textContent).toMatch(/GitHub didn't enable auto-merge/);
    expect(notice.querySelector("details")?.textContent).toMatch(/has new commits/);
    expect(onClose).not.toHaveBeenCalled();
    // The preview is read again before another attempt can be made.
    await waitFor(() => expect(getPRMock).toHaveBeenCalledTimes(2));
  });

  it("cancels through the disable action", async () => {
    getPRMock.mockResolvedValue(pr({ mergeIntent: { kind: "queued", position: 2 } }));
    // The preview is always read past the provider's cache.
    dispatchMock.mockResolvedValue({ ok: true, result: { prNumber: 42, outcome: "dequeued" } });
    const { onClose } = renderDialog(request({ mode: "cancel", method: null }));

    await clickConfirm("Remove from queue");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.disableAutoMerge",
      { worktreePath: "/tmp/wt", prNumber: 42 },
      { source: "user" }
    );
  });

  it("reads past the provider cache every time it opens", async () => {
    getPRMock.mockResolvedValue(pr());
    renderDialog(request({ mode: "arm", method: "merge" }));
    await waitFor(() => expect(getPRMock).toHaveBeenCalled());
    expect(getPRMock.mock.calls[0]).toEqual(["/tmp/wt", 42, { fresh: true }]);
  });

  it("re-decides from the reload after already-mergeable rather than forcing a merge", async () => {
    getPRMock
      .mockResolvedValueOnce(pr())
      .mockResolvedValueOnce(pr({ mergeQueueRequired: true, mergeStatus: "clean" }));
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { prNumber: 42, outcome: "already-mergeable", message: "can merge" },
    });
    renderDialog(request({ mode: "arm", method: "merge" }));
    await clickConfirm("Enable auto-merge");

    // A queue branch never takes the REST merge, whatever the earlier answer said.
    await waitFor(() =>
      expect(screen.getByTestId("pr-merge-method").textContent).toBe("Set by the merge queue")
    );
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Merge when ready" })).toBeTruthy();
  });

  it.each([
    ["no commit list", { commits: undefined }, /didn't list the commits/],
    ["no head", { headSha: undefined }, /head commit/],
    ["an unknown repository", { url: "not a url" }, /repository couldn't be identified/],
    ["conflicts", { mergeStatus: "dirty" as const }, /conflicts/],
  ])("blocks the write when the preview has %s", async (_name, overrides, hint) => {
    getPRMock.mockResolvedValue(pr(overrides));
    renderDialog(request({ mode: "arm", method: "merge" }));
    expect(await screen.findByText(hint)).toBeTruthy();
    expect(isDisabled(screen.getByRole("button", { name: "Enable auto-merge" }))).toBe(true);
  });

  it("blocks a non-queue write when no method was established", async () => {
    getPRMock.mockResolvedValue(pr());
    renderDialog(request({ mode: "arm", method: null }));
    expect(await screen.findByText(/merge methods/)).toBeTruthy();
    expect(isDisabled(screen.getByRole("button", { name: "Enable auto-merge" }))).toBe(true);
  });

  it("blocks rather than guesses when the read carries no merge status", async () => {
    getPRMock.mockResolvedValue(pr({ mergeStatus: undefined }));
    renderDialog(request({ mode: "arm", method: "squash" }));
    expect(await screen.findByTestId("pr-merge-status-unreported")).toBeTruthy();
    expect(screen.queryByTestId("pr-merge-mode-changed")).toBeNull();
    expect(isDisabled(screen.getByRole("button", { name: "Enable auto-merge" }))).toBe(true);
  });

  it("stops offering to cancel once nothing is pending", async () => {
    getPRMock.mockResolvedValue(pr({ mergeIntent: null }));
    renderDialog(
      request({
        mode: "cancel",
        method: null,
        intent: { kind: "auto-merge", method: "squash", enabledAt: 1 },
      })
    );
    expect(await screen.findByText(/Nothing pending for #42/)).toBeTruthy();
    expect(isDisabled(screen.getByRole("button", { name: "Cancel auto-merge" }))).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("hands GitHub's reply over before closing", async () => {
    getPRMock.mockResolvedValue(pr({ mergeStatus: "clean" }));
    dispatchMock.mockResolvedValue({ ok: true, result: { prNumber: 42, merged: true } });
    const { onClose, onComplete } = renderDialog(request({ mode: "merge", method: "squash" }));

    await clickConfirm("Merge pull request");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalledWith({ kind: "merged", baseRef: "develop" });
  });

  it("blocks a cancel GitHub says the viewer can't make", async () => {
    getPRMock.mockResolvedValue(
      pr({
        mergeIntent: { kind: "auto-merge", method: "squash", enabledAt: 1 },
        viewerCanDisableAutoMerge: false,
      })
    );
    renderDialog(request({ mode: "cancel", method: null }));
    const button = await screen.findByRole("button", { name: "Cancel auto-merge" });
    await waitFor(() => screen.getByText(/doesn't let you cancel/));
    expect(isDisabled(button)).toBe(true);
  });
});
