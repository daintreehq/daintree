// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPullRebaseConfirmDialog } from "../GitPullRebaseConfirmDialog";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";

/**
 * Mirror of `GitPushConfirmDialog.test.tsx` for the rebase dialog. Both were
 * refactored onto the shared `buildGitRemoteOperationPreview` (#11538), and the
 * #9575 `confirmDisabled` load-state gate is per-dialog wiring — covering only
 * push would let a pull-only regression through.
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

function rebaseButton(): HTMLElement {
  return screen.getByRole("button", { name: "Pull and rebase" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("GitPullRebaseConfirmDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
      useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
    }
    cleanup();
    vi.restoreAllMocks();
  });

  it("reads the preview through the shared builder, scoped to the requested cwd", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "feature/y",
      destination: { remote: "origin", branch: "feature/y" },
      pullSource: { remote: "origin", branch: "feature/y" },
      commits: [],
    });
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
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
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(rebaseButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve({
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [],
      });
      await gate.promise;
    });

    expect(rebaseButton().hasAttribute("disabled")).toBe(false);
  });

  it("keeps approval blocked when the preview fetch fails", async () => {
    mocks.buildPreview.mockRejectedValue(new Error("git exploded"));
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(rebaseButton().hasAttribute("disabled")).toBe(true);
  });

  it("resolves the awaited confirm promise with the user's decision", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
    });
    render(<GitPullRebaseConfirmDialog />);

    let decision: boolean | undefined;
    await act(async () => {
      void useGitPullRebaseConfirmStore
        .getState()
        .requestConfirmation("/repo")
        .then((ok) => {
          decision = ok;
        });
    });

    await act(async () => {
      rebaseButton().click();
    });

    expect(decision).toBe(true);
  });
});
