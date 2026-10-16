// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionDispatchResult } from "@shared/types/actions";

const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

import { EditWorktreeTitleDialog } from "../EditWorktreeTitleDialog";

const ok: ActionDispatchResult = { ok: true, result: undefined };

function renderDialog(props: Partial<Parameters<typeof EditWorktreeTitleDialog>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <EditWorktreeTitleDialog
      isOpen
      onClose={onClose}
      worktreeId="wt-1"
      currentTitle="Release prep"
      {...props}
    />
  );
  return { ...utils, onClose };
}

function field(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Custom title" }) as HTMLInputElement;
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(ok);
});

afterEach(() => {
  cleanup();
});

describe("EditWorktreeTitleDialog", () => {
  it("prefills the current title under the dialog's own title and helper text", () => {
    renderDialog();

    expect(screen.getByText("Edit worktree title")).not.toBeNull();
    expect(screen.getByText("Leave blank to use the automatic title")).not.toBeNull();
    expect(field().value).toBe("Release prep");
  });

  it("saves the normalised title on Enter and closes once the action succeeds", async () => {
    const { onClose } = renderDialog();
    fireEvent.change(field(), { target: { value: "  Hotfix   train " } });

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.setCustomTitle",
      { worktreeId: "wt-1", title: "Hotfix train" },
      { source: "user" }
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not save on an Enter that commits an IME composition", () => {
    renderDialog();

    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("clears the title when saved blank", async () => {
    renderDialog();
    fireEvent.change(field(), { target: { value: "   " } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.setCustomTitle",
      { worktreeId: "wt-1", title: null },
      { source: "user" }
    );
  });

  it("rejects a title over 80 characters instead of truncating it", () => {
    renderDialog();
    fireEvent.change(field(), { target: { value: "x".repeat(81) } });

    expect(screen.getByText("Use 80 characters or fewer")).not.toBeNull();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    // Footer actions announce unavailability with aria-disabled, never `disabled`.
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("stays open and says why when the action fails", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "Worktree not found: wt-1" },
    });
    const { onClose } = renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Worktree not found: wt-1")
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("starts each opening from the stored title, not the last cancelled edit", () => {
    const { rerender, onClose } = renderDialog();
    fireEvent.change(field(), { target: { value: "abandoned" } });

    const props = { onClose, worktreeId: "wt-1", currentTitle: "Release prep" };
    rerender(<EditWorktreeTitleDialog isOpen={false} {...props} />);
    rerender(<EditWorktreeTitleDialog isOpen {...props} />);

    expect(field().value).toBe("Release prep");
  });
});
