// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeState } from "@shared/types";

const hostMock = vi.hoisted(() => ({ copies: false }));
const copyWithToast = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("@/hooks/useHostPlatform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useHostPlatform")>()),
  revealCopiesHostPath: () => hostMock.copies,
  hostFileManagerRevealLabel: () => (hostMock.copies ? "Copy host path" : "Show in file manager"),
}));
vi.mock("@/lib/copyWithToast", () => ({ copyWithToast }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, isEnabled: () => true, get: () => undefined },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { WorktreeOverviewRow } from "../WorktreeOverviewRow";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

const WT = "/repo-wt-1";
const worktree = {
  id: WT,
  worktreeId: WT,
  path: WT,
  name: "wt-1",
  branch: "feature/one",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: 1_000,
} as WorktreeState;

beforeEach(() => {
  Reflect.set(window, "electron", {
    plugin: { onWorktreeCardStatusesChanged: vi.fn(() => () => {}) },
  });
  copyWithToast.mockClear();
  dispatch.mockClear();
});

afterEach(() => cleanup());

function openMenu() {
  const store = createWorktreeStore();
  store.setState({ worktrees: new Map([[WT, worktree]]) });
  setCurrentViewStore(store);
  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={store}>
        <div role="grid">
          <WorktreeOverviewRow
            worktree={worktree}
            cellId="overview-cell"
            chipState={null}
            isCurrent={false}
            isSelected={false}
            isCursor={false}
            isSelecting={false}
            isLast
            onActivate={vi.fn()}
            onToggleSelect={vi.fn()}
            onBeforeMenuAction={vi.fn()}
            onFocusLost={vi.fn()}
          />
        </div>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  fireEvent.contextMenu(document.querySelector("[data-worktree-overview-cell]")!);
}

describe("WorktreeOverviewRow reveal on a remote host (#16890)", () => {
  it("copies the host path instead of revealing it in a file manager", async () => {
    hostMock.copies = true;
    openMenu();
    fireEvent.click(await screen.findByText("Copy host path"));
    expect(copyWithToast).toHaveBeenCalledWith("Path", WT);
    expect(dispatch).not.toHaveBeenCalledWith(
      "worktree.reveal",
      expect.anything(),
      expect.anything()
    );
  });

  it("keeps the file-manager reveal when the host's files are local", async () => {
    hostMock.copies = false;
    openMenu();
    fireEvent.click(await screen.findByText("Show in file manager"));
    expect(copyWithToast).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith("worktree.reveal", expect.anything(), expect.anything());
  });
});
