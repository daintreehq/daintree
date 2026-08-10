// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPushConfirmDialog } from "../GitPushConfirmDialog";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";

/**
 * The #9575 invariant: rendering a preview does NOT gate approval — the
 * `confirmDisabled` wiring is a manual, per-dialog responsibility that has
 * silently broken before. These cover the load-state gate directly, and the
 * fact that the dialog reads through the shared `buildGitRemoteOperationPreview`
 * so it can't drift from the MCP confirm surface (#11538).
 */

const mocks = vi.hoisted(() => ({ buildPreview: vi.fn() }));

vi.mock("@/components/Git/gitRemoteOperationPreview", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/Git/gitRemoteOperationPreview")>();
  return { ...actual, buildGitRemoteOperationPreview: mocks.buildPreview };
});

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function pushButton(): HTMLElement {
  return screen.getByRole("button", { name: "Push" });
}

/** A promise plus its resolvers, so a test can hold the fetch mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("GitPushConfirmDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    if (useGitPushConfirmStore.getState().pendingConfirm) {
      useGitPushConfirmStore.getState().resolveConfirmation(false);
    }
    cleanup();
    vi.restoreAllMocks();
  });

  it("reads the preview through the shared builder, scoped to the requested cwd", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "feature/x",
      destination: { remote: "origin", branch: "feature/x" },
      pullSource: { remote: "origin", branch: "feature/x" },
      commits: [],
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(mocks.buildPreview).toHaveBeenCalledWith("/repo");
  });

  it("blocks approval while the preview is still loading", async () => {
    const gate = deferred<{
      branch: string;
      destination: { remote: string; branch: string };
      pullSource: { remote: string; branch: string };
      commits: never[];
    }>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve({
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [],
      });
      await gate.promise;
    });

    expect(pushButton().hasAttribute("disabled")).toBe(false);
  });

  // `commits.length === 0` is a VALID loaded state — it means "nothing ahead",
  // not "still loading". Blocking on it was the #9575 failure mode.
  it("allows approval once loaded even with no commits to show", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/No local commits found/)).toBeTruthy();
  });

  it("keeps approval blocked when the preview fetch fails, and offers a retry", async () => {
    mocks.buildPreview.mockRejectedValue(new Error("git exploded"));
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().hasAttribute("disabled")).toBe(true);
    const retry = screen.getByTestId("git-push-commits-retry");

    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [{ hash: "abcdef1234", message: "Fix it", author: "Ada" }],
    });
    await act(async () => {
      retry.click();
    });

    expect(mocks.buildPreview).toHaveBeenCalledTimes(2);
    expect(pushButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Fix it")).toBeTruthy();
  });

  it("resolves the awaited confirm promise with the user's decision", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
    });
    render(<GitPushConfirmDialog />);

    let decision: boolean | undefined;
    await act(async () => {
      void useGitPushConfirmStore
        .getState()
        .requestConfirmation("/repo")
        .then((ok) => {
          decision = ok;
        });
    });

    await act(async () => {
      pushButton().click();
    });

    expect(decision).toBe(true);
  });
});
