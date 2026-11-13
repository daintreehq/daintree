// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  useWorktreeResourceTeardownConfirmStore,
  type ResourceTeardownConfirmRequest,
} from "@/store/worktreeResourceTeardownConfirmStore";
import { WorktreeResourceTeardownConfirmDialog } from "../WorktreeResourceTeardownConfirmDialog";

function open(overrides: Partial<ResourceTeardownConfirmRequest> = {}): Promise<boolean> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = useWorktreeResourceTeardownConfirmStore.getState().requestConfirmation({
      worktreeId: "/box",
      label: "feature/box",
      commands: ["devbox rm box", "dns rm box.dev"],
      approved: true,
      ...overrides,
    });
  });
  return answer;
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
  if (!el) throw new Error("dialog not open");
  return el;
}

const button = (label: string) =>
  Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent === label)!;

const preview = () =>
  dialog().querySelector<HTMLElement>('[data-testid="resource-teardown-preview"]')!;

const isGated = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

/** Past the read-time gate a destructive confirm holds its primary behind. */
function readThrough() {
  act(() => {
    vi.advanceTimersByTime(1_200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  useWorktreeResourceTeardownConfirmStore.getState().resolveConfirmation(false);
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("WorktreeResourceTeardownConfirmDialog", () => {
  it("renders nothing until a request is pending", () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  });

  it("names the worktree, lists every command, and resolves true on confirm", async () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    const answer = open();
    expect(dialog().textContent).toContain("Tear down resource for 'feature/box'?");
    expect(preview().querySelector("pre")!.textContent).toBe("devbox rm box\ndns rm box.dev");
    expect(preview().textContent).toContain("Commands that will run");

    readThrough();
    act(() => {
      fireEvent.click(button("Tear down resource"));
    });
    expect(await answer).toBe(true);
  });

  it("resolves false on cancel", async () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    const answer = open();

    act(() => {
      fireEvent.click(button("Cancel"));
    });
    expect(await answer).toBe(false);
  });

  it("still lists the commands, but says they await approval rather than that they will run", () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    void open({ approved: false });
    expect(preview().querySelector("pre")!.textContent).toBe("devbox rm box\ndns rm box.dev");
    expect(preview().textContent).not.toContain("Commands that will run");
    expect(preview().textContent).toContain("isn't approved yet");
  });

  it.each([true, false])(
    "says there are no commands, and nothing about approval, when none were found (approved %s)",
    (approved) => {
      render(<WorktreeResourceTeardownConfirmDialog />);
      void open({ commands: [], approved });
      expect(preview().querySelector("pre")!.textContent).toBe("No teardown commands found.");
      expect(preview().textContent).not.toContain("isn't approved yet");
    }
  );

  it("answers a superseded request no, and holds the new one's confirm for its own read", async () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    const first = open({ label: "first" });
    readThrough();
    expect(isGated(button("Tear down resource"))).toBe(false);

    const second = open({ label: "second" });
    expect(await first).toBe(false);
    expect(dialog().textContent).toContain("'second'");
    // The press that was about to approve the first can't approve the second.
    expect(isGated(button("Tear down resource"))).toBe(true);
    act(() => {
      fireEvent.click(button("Tear down resource"));
    });
    expect(useWorktreeResourceTeardownConfirmStore.getState().pendingConfirm).not.toBeNull();

    readThrough();
    act(() => {
      fireEvent.click(button("Tear down resource"));
    });
    expect(await second).toBe(true);
  });

  it("settles a pending request false when the host unmounts", async () => {
    const { unmount } = render(<WorktreeResourceTeardownConfirmDialog />);
    const answer = open();

    unmount();
    expect(await answer).toBe(false);
  });
});
