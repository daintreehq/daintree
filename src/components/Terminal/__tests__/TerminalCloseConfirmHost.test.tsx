// @vitest-environment jsdom
/**
 * TerminalCloseConfirmHost — bridges `terminal.close` (Cmd+W) to the same
 * confirmation dialog the per-tab/header X buttons render inline (#6513).
 *
 * The host listens for `daintree:close-confirm` CustomEvents, captures the
 * terminalId from event.detail, and renders ConfirmDialog. Confirm calls
 * panelStore.trashPanel; cancel does nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

const trashPanelMock = vi.fn();

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ trashPanel: trashPanelMock }) },
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    confirmLabel,
    cancelLabel = "Cancel",
    onConfirm,
    onClose,
    variant,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onClose?: () => void;
    variant: string;
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="confirm-dialog" data-variant={variant}>
        <h2 data-testid="dialog-title">{title}</h2>
        <p data-testid="dialog-description">{description}</p>
        <button data-testid="dialog-cancel" onClick={onClose}>
          {cancelLabel}
        </button>
        <button data-testid="dialog-confirm" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { TerminalCloseConfirmHost } from "../TerminalCloseConfirmHost";

function dispatchCloseConfirm(detail: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent("daintree:close-confirm", { detail }));
  });
}

describe("TerminalCloseConfirmHost (#6513)", () => {
  beforeEach(() => {
    trashPanelMock.mockClear();
  });

  it("renders nothing until a daintree:close-confirm event arrives", () => {
    const { queryByTestId } = render(<TerminalCloseConfirmHost />);
    expect(queryByTestId("confirm-dialog")).toBeNull();
  });

  it("opens the dialog with destructive copy when an event arrives", () => {
    const { queryByTestId, getByTestId } = render(<TerminalCloseConfirmHost />);

    dispatchCloseConfirm({ terminalId: "term-1" });

    const dialog = queryByTestId("confirm-dialog");
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute("data-variant")).toBe("destructive");
    expect(getByTestId("dialog-title").textContent).toBe("Stop this agent?");
    expect(getByTestId("dialog-description").textContent).toBe(
      "The agent is currently working. Closing this tab will stop it."
    );
    expect(getByTestId("dialog-confirm").textContent).toBe("Stop and close");
  });

  it("trashes the panel when the user confirms", () => {
    const { getByTestId, queryByTestId } = render(<TerminalCloseConfirmHost />);

    dispatchCloseConfirm({ terminalId: "term-7" });
    fireEvent.click(getByTestId("dialog-confirm"));

    expect(trashPanelMock).toHaveBeenCalledWith("term-7");
    expect(queryByTestId("confirm-dialog")).toBeNull();
  });

  it("does not trash when the user cancels", () => {
    const { getByTestId, queryByTestId } = render(<TerminalCloseConfirmHost />);

    dispatchCloseConfirm({ terminalId: "term-7" });
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(trashPanelMock).not.toHaveBeenCalled();
    expect(queryByTestId("confirm-dialog")).toBeNull();
  });

  it("ignores events without a string terminalId", () => {
    const { queryByTestId } = render(<TerminalCloseConfirmHost />);

    dispatchCloseConfirm({});
    expect(queryByTestId("confirm-dialog")).toBeNull();

    dispatchCloseConfirm({ terminalId: 42 });
    expect(queryByTestId("confirm-dialog")).toBeNull();

    dispatchCloseConfirm(undefined);
    expect(queryByTestId("confirm-dialog")).toBeNull();
  });

  it("ignores a second event while a dialog is already open (target stays the first id)", () => {
    const { getByTestId } = render(<TerminalCloseConfirmHost />);

    dispatchCloseConfirm({ terminalId: "term-first" });
    dispatchCloseConfirm({ terminalId: "term-second" });

    fireEvent.click(getByTestId("dialog-confirm"));

    expect(trashPanelMock).toHaveBeenCalledTimes(1);
    expect(trashPanelMock).toHaveBeenCalledWith("term-first");
  });

  it("removes the event listener on unmount", () => {
    const { unmount, queryByTestId } = render(<TerminalCloseConfirmHost />);
    unmount();

    dispatchCloseConfirm({ terminalId: "term-after-unmount" });
    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(trashPanelMock).not.toHaveBeenCalled();
  });
});
