// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { RelocationPreview } from "@shared/types/projectRelocation";

// ConfirmDialog's scroll-shadow hook observes its scroll container, which jsdom
// does not implement.
class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

const { previewRelocation, applyRelocation, openDialog, updateProject } = vi.hoisted(() => ({
  previewRelocation: vi.fn<(req: unknown) => Promise<RelocationPreview>>(),
  applyRelocation: vi.fn<(req: unknown) => Promise<unknown>>(() => Promise.resolve({})),
  openDialog: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
  updateProject: vi.fn<(id: string, updates: unknown) => Promise<void>>(() =>
    Promise.resolve()
  ),
}));

vi.mock("@/clients", () => ({
  projectClient: { previewRelocation, applyRelocation, openDialog },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { updateProject: typeof updateProject }) => unknown) =>
    selector({ updateProject }),
}));

import { useProjectRelocationStore } from "@/store/projectRelocationStore";
import { MoveOrRenameProjectDialog } from "../MoveOrRenameProjectDialog";

const OLD_PATH = "/repos/proj";

function cleanPreview(overrides: Partial<RelocationPreview> = {}): RelocationPreview {
  return {
    mode: "move",
    oldPath: OLD_PATH,
    newPath: "/repos/proj2",
    runningTerminalCount: 0,
    linkedWorktrees: [],
    affectedPanelCount: 0,
    blockers: [],
    ...overrides,
  };
}

function openMove(): void {
  useProjectRelocationStore
    .getState()
    .open({ projectId: "p1", mode: "move", oldPath: OLD_PATH, name: "Proj" });
}

function confirmButton(): HTMLButtonElement {
  return document.querySelector('[data-confirm-role="confirm"]') as HTMLButtonElement;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  previewRelocation.mockResolvedValue(cleanPreview());
  applyRelocation.mockResolvedValue({});
  openDialog.mockResolvedValue(null);
  updateProject.mockResolvedValue();
  useProjectRelocationStore.setState({ pending: null, requestSeq: 0 });
});

describe("MoveOrRenameProjectDialog", () => {
  it("renders nothing when no relocation is pending", () => {
    render(<MoveOrRenameProjectDialog />);
    expect(document.querySelector('[data-testid="move-or-rename-project-dialog"]')).toBeNull();
  });

  it("move mode seeds the fields and starts with confirm disabled (nothing changed)", () => {
    openMove();
    render(<MoveOrRenameProjectDialog />);

    expect(screen.getByText("Move or rename project")).toBeTruthy();
    expect((screen.getByTestId("relocate-name-input") as HTMLInputElement).value).toBe("Proj");
    expect((screen.getByTestId("relocate-folder-input") as HTMLInputElement).value).toBe("proj");
    expect(confirmButton().disabled).toBe(true);
    expect(previewRelocation).not.toHaveBeenCalled();
  });

  it("a display-name-only change takes the lightweight updateProject fast path", async () => {
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-name-input"), { target: { value: "Renamed" } });

    const btn = confirmButton();
    expect(btn.textContent).toContain("Rename project");
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith("p1", { name: "Renamed" }));
    // No filesystem op — the fast path never touches the coordinator.
    expect(previewRelocation).not.toHaveBeenCalled();
    expect(applyRelocation).not.toHaveBeenCalled();
    await waitFor(() => expect(useProjectRelocationStore.getState().pending).toBeNull());
  });

  it("keeps confirm disabled until the async preview loads (null sentinel)", async () => {
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    // Folder changed, preview not yet loaded → confirm gated.
    expect(confirmButton().disabled).toBe(true);

    await waitFor(() => expect(previewRelocation).toHaveBeenCalled());
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it("blockers in the preview keep confirm disabled and surface their messages", async () => {
    previewRelocation.mockResolvedValue(
      cleanPreview({
        blockers: [
          { reason: "cross-volume", message: "Moving across volumes isn't supported yet." },
        ],
      })
    );
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });

    await waitFor(() =>
      expect(screen.getByText(/Moving across volumes isn't supported yet/)).toBeTruthy()
    );
    expect(confirmButton().disabled).toBe(true);
  });

  it("a full move calls applyRelocation with the previewed destination", async () => {
    previewRelocation.mockResolvedValue(cleanPreview({ runningTerminalCount: 2 }));
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(applyRelocation).toHaveBeenCalledWith({
        projectId: "p1",
        mode: "move",
        newPath: "/repos/proj2",
      })
    );
  });

  it("reattach mode browses to an existing folder then reattaches", async () => {
    openDialog.mockResolvedValue("/moved/proj");
    previewRelocation.mockResolvedValue(cleanPreview({ mode: "reattach", newPath: "/moved/proj" }));
    useProjectRelocationStore
      .getState()
      .open({ projectId: "p1", mode: "reattach", oldPath: OLD_PATH, name: "Proj" });
    render(<MoveOrRenameProjectDialog />);

    expect(screen.getByText("Locate moved project")).toBeTruthy();
    fireEvent.click(screen.getByTestId("relocate-browse-existing"));

    await waitFor(() => expect(previewRelocation).toHaveBeenCalled());
    await waitFor(() => {
      const btn = confirmButton();
      expect(btn.textContent).toContain("Reattach project");
      expect(btn.disabled).toBe(false);
    });

    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(applyRelocation).toHaveBeenCalledWith({
        projectId: "p1",
        mode: "reattach",
        newPath: "/moved/proj",
      })
    );
  });
});
