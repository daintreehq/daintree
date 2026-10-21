/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeAttachment } from "@shared/types/worktree";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeAttachmentChips } from "../WorktreeAttachmentChips";
import { attachmentChipState, visibleAttachmentChips } from "../attachmentState";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

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

const base: WorktreeAttachment = { name: "tunnel", heldHere: false, hasStatusCommand: true };

describe("attachmentChipState", () => {
  it("shows nothing on a worktree that neither holds it nor saw it fail", () => {
    expect(attachmentChipState(base)).toBeNull();
    expect(
      attachmentChipState({
        ...base,
        holderWorktreeId: "/wt/a",
        lastResult: { action: "detach", worktreeId: "/wt/b", state: "success", at: 1 },
      })
    ).toBeNull();
  });

  it("reads attached only on the holder while nothing it ran has failed", () => {
    expect(attachmentChipState({ ...base, heldHere: true, holderWorktreeId: "/wt/a" })).toEqual({
      label: "Attached",
      tone: "neutral",
    });
    expect(
      attachmentChipState({
        ...base,
        heldHere: true,
        lastResult: { action: "detach", worktreeId: "/wt/a", state: "failed", at: 1 },
      })
    ).toEqual({ label: "Detach failed", tone: "error" });
    expect(
      attachmentChipState({
        ...base,
        heldHere: true,
        status: { action: "status", worktreeId: "/wt/a", state: "timed-out", at: 1 },
      })
    ).toEqual({ label: "Status check timed out", tone: "error" });
  });

  it("keeps a failed attach visible on the worktree it was meant for", () => {
    expect(
      attachmentChipState({
        ...base,
        lastResult: { action: "attach", worktreeId: "/wt/b", state: "failed", at: 1 },
      })
    ).toEqual({ label: "Attach failed", tone: "error" });
  });

  it("reports a running command over any earlier result", () => {
    expect(
      attachmentChipState({
        ...base,
        heldHere: true,
        running: "detach",
        lastResult: { action: "detach", worktreeId: "/wt/a", state: "failed", at: 1 },
      })
    ).toEqual({ label: "Detaching…", tone: "working" });
    expect(visibleAttachmentChips([base, { ...base, name: "device", running: "attach" }])).toEqual([
      {
        attachment: { ...base, name: "device", running: "attach" },
        state: { label: "Attaching…", tone: "working" },
      },
    ]);
  });
});

describe("WorktreeAttachmentChips", () => {
  function renderChips(attachments: WorktreeAttachment[], onAction = vi.fn()) {
    render(
      <TooltipProvider>
        <WorktreeAttachmentChips attachments={attachments} onAction={onAction} />
      </TooltipProvider>
    );
    return onAction;
  }

  it("renders nothing when no attachment has a chip here", () => {
    const { container } = render(
      <TooltipProvider>
        <WorktreeAttachmentChips attachments={[base]} onAction={vi.fn()} />
      </TooltipProvider>
    );
    expect(container.textContent).toBe("");
  });

  it("names the attachment and its observed state on the chip", () => {
    renderChips([
      {
        ...base,
        lastResult: {
          action: "attach",
          worktreeId: "/wt/b",
          state: "failed",
          error: "no device",
          at: 1,
        },
      },
    ]);
    const chip = screen.getByRole("button", { name: "tunnel attachment: Attach failed" });
    expect(chip.textContent).toContain("tunnel");
  });

  it("offers status and detach from the holder's chip", () => {
    const onAction = renderChips([
      {
        ...base,
        heldHere: true,
        holderWorktreeId: "/wt/a",
        status: {
          action: "status",
          worktreeId: "/wt/a",
          state: "success",
          output: "online",
          at: 1,
        },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "tunnel attachment: Attached" }));
    expect(screen.getByRole("region", { name: "Status output" }).textContent).toBe("online");

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(onAction).toHaveBeenLastCalledWith("tunnel", "status");
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(onAction).toHaveBeenLastCalledWith("tunnel", "detach");
  });

  it("drops the names from the header once several chips share it, keeping them in the label", () => {
    renderChips([
      { ...base, heldHere: true, holderWorktreeId: "/wt/a" },
      { ...base, name: "device", heldHere: true, holderWorktreeId: "/wt/a" },
    ]);
    const tunnel = screen.getByRole("button", { name: "tunnel attachment: Attached" });
    const device = screen.getByRole("button", { name: "device attachment: Attached" });
    expect(tunnel.textContent).toBe("");
    expect(device.textContent).toBe("");
  });

  it("disables the holder's controls while a request for it is outstanding", () => {
    renderChips([{ ...base, heldHere: true, holderWorktreeId: "/wt/a", busy: true }]);
    fireEvent.click(screen.getByRole("button", { name: "tunnel attachment: Attached" }));
    expect((screen.getByRole("button", { name: "Detach" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("offers no controls on a worktree that does not hold it", () => {
    renderChips([
      {
        ...base,
        lastResult: { action: "attach", worktreeId: "/wt/b", state: "failed", at: 1 },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "tunnel attachment: Attach failed" }));
    expect(screen.queryByRole("button", { name: "Detach" })).toBeNull();
  });
});
