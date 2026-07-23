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
  updateProject: vi.fn<(id: string, updates: unknown) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("@/clients", () => ({
  projectClient: { previewRelocation, applyRelocation, openDialog },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { updateProject: typeof updateProject }) => unknown) =>
    selector({ updateProject }),
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { useProjectRelocationStore } from "@/store/projectRelocationStore";
import { MoveOrRenameProjectDialog } from "../MoveOrRenameProjectDialog";

const OLD_PATH = "/repos/proj";

function cleanPreview(overrides: Partial<RelocationPreview> = {}): RelocationPreview {
  return {
    mode: "move",
    oldPath: OLD_PATH,
    newPath: "/repos/proj2",
    runningTerminalCount: 0,
    agentContinuity: [],
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

  it("surfaces per-agent conversation continuity without blocking confirm (#11282 phase 5)", async () => {
    previewRelocation.mockResolvedValue(
      cleanPreview({
        runningTerminalCount: 3,
        agentContinuity: [
          {
            agentId: "claude",
            agentName: "Claude Code",
            count: 1,
            tier: "provider-migration",
            detail: "Claude Code can't resume this after the move",
          },
          // No `detail` → the component falls back to the per-tier line.
          { agentId: "codex", agentName: "Codex", count: 2, tier: "preserved" },
        ],
      })
    );
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });

    await waitFor(() => expect(screen.getByTestId("relocate-continuity")).toBeTruthy());
    // The riskiest tier's warning label renders.
    expect(screen.getByText("Provider migration required")).toBeTruthy();
    // Provider-specific detail is shown verbatim…
    expect(screen.getByText("Claude Code can't resume this after the move")).toBeTruthy();
    // …and an agent without a detail falls back to the generic per-tier line.
    expect(screen.getByText("Expected to resume automatically at the new location")).toBeTruthy();
    // Count > 1 is surfaced next to the agent name.
    expect(screen.getByText(/Codex \(2\)/)).toBeTruthy();
    // Continuity is informational — it must NOT disable confirm (only blockers do).
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it("renders a single-terminal agent without a count suffix (#11282 phase 5)", async () => {
    previewRelocation.mockResolvedValue(
      cleanPreview({
        runningTerminalCount: 1,
        agentContinuity: [{ agentId: "codex", agentName: "Codex", count: 1, tier: "preserved" }],
      })
    );
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });

    await waitFor(() => expect(screen.getByTestId("relocate-continuity-codex")).toBeTruthy());
    const row = screen.getByTestId("relocate-continuity-codex").textContent ?? "";
    // count === 1 → bare agent name, no "(1)" suffix.
    expect(row).toContain("Codex");
    expect(row).not.toContain("(1)");
  });

  it("shows no continuity section when only plain terminals run, and states terminals restart (#11282 phase 5)", async () => {
    previewRelocation.mockResolvedValue(
      cleanPreview({ runningTerminalCount: 2, agentContinuity: [] })
    );
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });

    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    // No agents → no continuity section.
    expect(screen.queryByTestId("relocate-continuity")).toBeNull();
    // The terminal line describes restart, not conversation preservation.
    expect(screen.getByText(/they restart at the new location/)).toBeTruthy();
    expect(screen.queryByText(/sessions are preserved and restored/)).toBeNull();
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

  it("reattach accepts the original path (a removable volume that reappeared)", async () => {
    openDialog.mockResolvedValue(OLD_PATH);
    previewRelocation.mockResolvedValue(cleanPreview({ mode: "reattach", newPath: OLD_PATH }));
    useProjectRelocationStore
      .getState()
      .open({ projectId: "p1", mode: "reattach", oldPath: OLD_PATH, name: "Proj" });
    render(<MoveOrRenameProjectDialog />);

    fireEvent.click(screen.getByTestId("relocate-browse-existing"));
    await waitFor(() => expect(previewRelocation).toHaveBeenCalled());
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(applyRelocation).toHaveBeenCalledWith({
        projectId: "p1",
        mode: "reattach",
        newPath: OLD_PATH,
      })
    );
  });

  it("calls onDisplayNameCommitted after a rename so Settings can resync", async () => {
    const onCommitted = vi.fn();
    useProjectRelocationStore.getState().open({
      projectId: "p1",
      mode: "move",
      oldPath: OLD_PATH,
      name: "Proj",
      onDisplayNameCommitted: onCommitted,
    });
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-name-input"), { target: { value: "Renamed" } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith("Renamed"));
  });

  it("ignores a stale preview response after the folder reverts", async () => {
    let resolveA: (v: RelocationPreview) => void = () => {};
    const deferredA = new Promise<RelocationPreview>((r) => {
      resolveA = r;
    });
    previewRelocation.mockReturnValueOnce(deferredA);
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(previewRelocation).toHaveBeenCalledTimes(1));

    // Revert to the original folder → destination unchanged → the in-flight
    // request is invalidated by the bumped request id.
    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj" } });

    // The stale response lands AFTER the revert; it must not repopulate the preview.
    resolveA(cleanPreview());
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('[data-testid="relocate-preview"]')).toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });
});
