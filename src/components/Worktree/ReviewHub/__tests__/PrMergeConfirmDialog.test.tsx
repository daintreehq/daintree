/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import type { PR } from "@shared/types/forge";

const getPRMock = vi.fn<(cwd: string, prNumber: number) => Promise<PR | null>>();
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
  forgeClient: { getPR: (cwd: string, prNumber: number) => getPRMock(cwd, prNumber) },
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

function renderDialog(request: React.ComponentProps<typeof PrMergeConfirmDialog>["request"]) {
  const onClose = vi.fn();
  render(
    <PrMergeConfirmDialog
      worktreePath="/tmp/wt"
      prNumber={42}
      request={request}
      onClose={onClose}
    />
  );
  return { onClose };
}

describe("PrMergeConfirmDialog", () => {
  it("previews what lands and arms pinned to the previewed head", async () => {
    getPRMock.mockResolvedValue(pr());
    dispatchMock.mockResolvedValue({ ok: true, result: { prNumber: 42, outcome: "armed" } });
    const { onClose } = renderDialog({ mode: "arm", method: "squash" });

    await waitFor(() => expect(screen.getByTestId("pr-merge-head").textContent).toBe("abcdef1"));
    expect(screen.getByTestId("pr-merge-base").textContent).toBe("develop");
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(screen.getByTestId("pr-merge-method").textContent).toBe("squash");
    expect(screen.getAllByTestId("pr-merge-commit-row")).toHaveLength(1);
    expect(screen.getByTestId("pr-merge-push-warning").textContent).toMatch(/your own agents/);

    fireEvent.click(screen.getByRole("button", { name: "Merge when ready" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.enableAutoMerge",
      { worktreePath: "/tmp/wt", prNumber: 42, mergeMethod: "squash", expectedHeadSha: HEAD },
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
    const { onClose } = renderDialog({ mode: "arm", method: "merge" });

    await waitFor(() => screen.getByTestId("pr-merge-head"));
    fireEvent.click(screen.getByRole("button", { name: "Merge when ready" }));

    const mergeButton = await screen.findByRole("button", { name: "Merge" });
    expect(screen.getByTestId("pr-merge-mode-changed")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls.some(([id]) => id === "forge.mergePR")).toBe(false);

    dispatchMock.mockResolvedValueOnce({ ok: true, result: { prNumber: 42, merged: true } });
    fireEvent.click(mergeButton);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "forge.mergePR",
      { worktreePath: "/tmp/wt", prNumber: 42, mergeMethod: "merge", expectedHeadSha: HEAD },
      { source: "user" }
    );
  });

  it("offers a PR that turned mergeable since the popover as Merge, under a notice", async () => {
    getPRMock.mockResolvedValue(pr({ mergeStatus: "clean" }));
    renderDialog({ mode: "arm", method: null });

    expect(await screen.findByRole("button", { name: "Merge" })).toBeTruthy();
    expect(screen.getByTestId("pr-merge-mode-changed").textContent).toMatch(/can merge now/i);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("names the queue's method rather than inventing one", async () => {
    getPRMock.mockResolvedValue(pr({ mergeQueueRequired: true }));
    dispatchMock.mockResolvedValue({ ok: true, result: { prNumber: 42, outcome: "armed" } });
    renderDialog({ mode: "arm", method: "squash" });

    await waitFor(() =>
      expect(screen.getByTestId("pr-merge-method").textContent).toBe("Set by the merge queue")
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge when ready" }));
    await waitFor(() => expect(dispatchMock).toHaveBeenCalled());
    expect(dispatchMock.mock.calls[0]?.[1]).toEqual({
      worktreePath: "/tmp/wt",
      prNumber: 42,
      expectedHeadSha: HEAD,
    });
  });

  it("keeps a rejected write inside the dialog", async () => {
    getPRMock.mockResolvedValue(pr());
    dispatchMock.mockResolvedValue({ ok: false, error: { message: "has new commits" } });
    const { onClose } = renderDialog({ mode: "arm", method: null });

    await waitFor(() => screen.getByTestId("pr-merge-head"));
    fireEvent.click(screen.getByRole("button", { name: "Merge when ready" }));

    expect((await screen.findByTestId("pr-merge-error")).textContent).toMatch(/new commits/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels through the disable action", async () => {
    getPRMock.mockResolvedValue(pr({ mergeIntent: { kind: "queued", position: 2 } }));
    dispatchMock.mockResolvedValue({ ok: true, result: { prNumber: 42, outcome: "dequeued" } });
    const { onClose } = renderDialog({ mode: "cancel", method: null });

    fireEvent.click(await screen.findByRole("button", { name: "Remove from queue" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.disableAutoMerge",
      { worktreePath: "/tmp/wt", prNumber: 42 },
      { source: "user" }
    );
  });
});
