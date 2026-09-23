// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { RelocationPreview } from "@shared/types/projectRelocation";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    expect(previewRelocation).not.toHaveBeenCalled();
  });

  it("a display-name-only change takes the lightweight updateProject fast path", async () => {
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-name-input"), { target: { value: "Renamed" } });

    const btn = confirmButton();
    expect(btn.textContent).toContain("Rename project");
    expect(btn.hasAttribute("aria-disabled")).toBe(false);

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
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");

    await waitFor(() => expect(previewRelocation).toHaveBeenCalled());
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
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
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("a full move calls applyRelocation with the previewed destination", async () => {
    previewRelocation.mockResolvedValue(cleanPreview({ runningTerminalCount: 2 }));
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));

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
    // The tier colour is meaning rather than emphasis, so it stays on the
    // status and weight is what keeps the agent name apart from it when
    // forced-colors repaints both to the same ink.
    const claudeRow = screen.getByTestId("relocate-continuity-claude");
    const identity = within(claudeRow).getByText("Claude Code");
    const status = within(claudeRow).getByText("Provider migration required");
    expect(status.previousSibling).toBe(identity);
    expect(status.textContent).toMatch(/^\s/);
    // Continuity is informational — it must NOT disable confirm (only blockers do).
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
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

    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
    // No agents → no continuity section.
    expect(screen.queryByTestId("relocate-continuity")).toBeNull();
    // The terminal line describes restart, not conversation preservation.
    expect(screen.getByText(/They restart at the new location/)).toBeTruthy();
    expect(screen.queryByText(/sessions are preserved and restored/)).toBeNull();

    // The consequence outranks the reassurance by weight, not punctuation.
    const consequence = screen.getByText("2 terminals will be gracefully stopped");
    const reassurance = screen.getByText("They restart at the new location");
    expect(reassurance.previousSibling).toBe(consequence);
    expect(reassurance.textContent).toMatch(/^\s/);
    expect(consequence.parentElement?.textContent).toBe(
      `${consequence.textContent}${reassurance.textContent}`
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
    fireEvent.click(screen.getByRole("button", { name: "Browse for the project folder" }));

    await waitFor(() => expect(previewRelocation).toHaveBeenCalled());
    await waitFor(() => {
      const btn = confirmButton();
      expect(btn.textContent).toContain("Reattach project");
      expect(btn.hasAttribute("aria-disabled")).toBe(false);
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

    fireEvent.click(screen.getByRole("button", { name: "Browse for the project folder" }));
    await waitFor(() => expect(previewRelocation).toHaveBeenCalled());
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));

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
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("never lets an invalid or emptied folder name ride along as a name-only rename", async () => {
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-name-input"), { target: { value: "Renamed" } });
    for (const folder of ["proj:2", "   "]) {
      fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: folder } });
      expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(confirmButton());
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(updateProject).not.toHaveBeenCalled();
    expect(applyRelocation).not.toHaveBeenCalled();
  });

  it("explains an unavailable primary in the footer status line", async () => {
    const status = () => screen.getByTestId("relocate-status").textContent?.trim() ?? "";
    previewRelocation.mockResolvedValue(
      cleanPreview({ blockers: [{ reason: "destination-exists", message: "Already there" }] })
    );
    openMove();
    render(<MoveOrRenameProjectDialog />);

    // At rest, invalid, and blocked: each disabled state says why.
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    const atRest = status();
    expect(atRest).not.toBe("");

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj:2" } });
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    const invalid = status();
    expect(invalid).not.toBe("");
    expect(invalid).not.toBe(atRest);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(screen.getByText("Already there")).toBeTruthy());
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    expect(status()).not.toBe("");
    expect(status()).not.toBe(invalid);
  });

  it("names the destination beside the primary once the move is ready", async () => {
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
    expect(screen.getByTestId("relocate-status").textContent).toContain("/repos/proj2");
  });

  it("freezes every field while the commit is in flight", async () => {
    applyRelocation.mockReturnValue(new Promise(() => {}));
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
    fireEvent.click(confirmButton());

    await waitFor(() => expect(applyRelocation).toHaveBeenCalled());
    const fields = document.querySelectorAll<HTMLInputElement>(
      '[data-testid="move-or-rename-project-dialog"] input'
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(field.disabled).toBe(true);
    expect(confirmButton().getAttribute("aria-busy")).toBe("true");
  });

  it("retries a failed preview for the same destination", async () => {
    previewRelocation.mockRejectedValueOnce(new Error("EACCES"));
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(screen.getByTestId("relocate-preview-error")).toBeTruthy());
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(previewRelocation).toHaveBeenCalledTimes(2));
    const [first, second] = previewRelocation.mock.calls;
    expect(second?.[0]).toEqual(first?.[0]);
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
  });

  it("clears a failed commit's error once the user changes what they asked for", async () => {
    applyRelocation.mockRejectedValueOnce(new Error("Nothing was moved"));
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByTestId("relocate-apply-error")).toBeTruthy());

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj3" } });
    expect(screen.queryByTestId("relocate-apply-error")).toBeNull();
  });

  it("opens with focus in the name field, not on the close button", async () => {
    openMove();
    render(<MoveOrRenameProjectDialog />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("relocate-name-input"))
    );
  });

  it("wraps preview paths only between folders, never inside a folder name", async () => {
    const longPath = "/Users/you/Library/Mobile Documents/helios-dashboard-realtime-console";
    previewRelocation.mockResolvedValue(cleanPreview({ newPath: longPath }));
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    const to = await screen.findByTestId("relocate-preview");
    expect(to.textContent).toBe(longPath);
    // One atomic box per folder: a line can only end between two of them, so
    // no hyphen or space inside a name is ever a break point.
    const segments = Array.from(to.children);
    expect(segments.length).toBe(longPath.split("/").length);
    segments.forEach((segment, i) => {
      expect(segment.classList.contains("inline-block")).toBe(true);
      const text = segment.textContent ?? "";
      const last = i === segments.length - 1;
      expect(text.slice(0, -1).includes("/")).toBe(false);
      expect(text.endsWith("/")).toBe(!last);
    });
  });

  it("swaps the focus ring to the error colour while the folder name is invalid", () => {
    // Not an assertion about which colours are used. The rule is that a field
    // whose focus outline is the accent must say what that outline becomes when
    // the field is invalid — or an invalid focused field draws an accent ring
    // around its red border, and the louder signal says nothing is wrong.
    openMove();
    render(<MoveOrRenameProjectDialog />);
    const field = screen.getByTestId("relocate-folder-input");
    fireEvent.change(field, { target: { value: "proj:2" } });

    expect(field.getAttribute("aria-invalid")).toBe("true");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBeTruthy();
    const classes = field.className.split(/\s+/);
    const accentOutline = classes.some((c) => /^focus-visible:outline-accent/.test(c));
    const errorOutline = classes.some((c) => /^focus-visible:outline-status-error/.test(c));
    const errorBorder = classes.some((c) => /^border-status-error/.test(c));
    expect(accentOutline && !errorOutline).toBe(false);
    expect(errorBorder).toBe(true);
  });

  it("asks for the folder in reattach mode even after the name is edited", () => {
    useProjectRelocationStore
      .getState()
      .open({ projectId: "p1", mode: "reattach", oldPath: OLD_PATH, name: "Proj" });
    render(<MoveOrRenameProjectDialog />);
    const status = () => screen.getByTestId("relocate-status").textContent ?? "";
    const before = status();

    fireEvent.change(screen.getByTestId("relocate-name-input"), { target: { value: "Renamed" } });
    expect(status()).toBe(before);
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps a failed commit in the footer status until the request changes", async () => {
    applyRelocation.mockRejectedValueOnce(new Error("Nothing was moved"));
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
    const ready = screen.getByTestId("relocate-status").textContent;
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByTestId("relocate-apply-error")).toBeTruthy());
    expect(screen.getByTestId("relocate-status").textContent).not.toBe(ready);
  });

  it("commits on Enter from a field only when the button could", async () => {
    openMove();
    render(<MoveOrRenameProjectDialog />);
    const folder = screen.getByTestId("relocate-folder-input");

    // Nothing changed yet: Enter is inert.
    fireEvent.keyDown(folder, { key: "Enter" });
    fireEvent.change(folder, { target: { value: "proj2" } });
    // Preview still pending: Enter is inert.
    fireEvent.keyDown(folder, { key: "Enter" });
    await waitFor(() => expect(confirmButton().hasAttribute("aria-disabled")).toBe(false));
    expect(applyRelocation).not.toHaveBeenCalled();

    fireEvent.keyDown(folder, { key: "Enter" });
    await waitFor(() => expect(applyRelocation).toHaveBeenCalledTimes(1));
  });

  it("turns a permission failure into something the user can act on, keeping the raw cause", async () => {
    previewRelocation.mockRejectedValueOnce(new Error("EACCES: permission denied, access '/x'"));
    openMove();
    render(<MoveOrRenameProjectDialog />);

    fireEvent.change(screen.getByTestId("relocate-folder-input"), { target: { value: "proj2" } });
    const raw = "EACCES: permission denied, access '/x'";
    const banner = await screen.findByTestId("relocate-preview-error");
    const text = banner.textContent ?? "";
    expect(text).toContain(raw);
    // Something beyond the title, the raw cause and the button has to tell the
    // user what to change before retrying.
    const guidance = text
      .replace(raw, "")
      .replace("Couldn't check what will change", "")
      .replace(/retry/i, "")
      .trim();
    expect(guidance.length).toBeGreaterThan(0);
  });
});
