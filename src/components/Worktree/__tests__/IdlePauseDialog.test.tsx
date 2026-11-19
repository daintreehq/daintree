// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdlePausePolicy } from "@shared/types/idlePause";

const worktreeClientMock = vi.hoisted(() => ({
  getIdlePause: vi.fn(),
  setIdlePause: vi.fn(),
}));

vi.mock("@/clients", () => ({ worktreeClient: worktreeClientMock }));

// The dialog primitive has its own suite; this one is about what idle pause feeds it.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    isOpen: boolean;
    title: ReactNode;
    children?: ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    confirmDisabled?: boolean;
    onConfirm: () => void;
    onClose?: () => void;
  }) =>
    props.isOpen ? (
      <div>
        <h2>{props.title}</h2>
        {props.children}
        <button type="button" onClick={props.onClose}>
          {props.cancelLabel ?? "Cancel"}
        </button>
        <button type="button" disabled={props.confirmDisabled} onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { IdlePauseDialog } from "../IdlePauseDialog";

const OFF: IdlePausePolicy = {
  status: "available",
  environment: "gpu",
  sourcePath: "/home/me/.daintree/projects/repo/settings.json",
  commands: ["stop-box {{worktree_name}}"],
  fingerprint: "a".repeat(64),
  enabled: false,
  changed: false,
};

function open(onClose = vi.fn()) {
  render(<IdlePauseDialog isOpen worktreeId="/wt" onClose={onClose} />);
  return onClose;
}

beforeEach(() => {
  worktreeClientMock.getIdlePause.mockReset();
  worktreeClientMock.setIdlePause.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("IdlePauseDialog (#17925)", () => {
  it("shows the pause commands, and turns on for exactly those", async () => {
    worktreeClientMock.getIdlePause.mockResolvedValue(OFF);
    const onClose = open();

    await screen.findByText("stop-box {{worktree_name}}");
    fireEvent.click(screen.getByRole("button", { name: "Turn on idle pause" }));

    await waitFor(() =>
      expect(worktreeClientMock.setIdlePause).toHaveBeenCalledWith("/wt", true, "a".repeat(64))
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("says the commands changed, and asks again", async () => {
    worktreeClientMock.getIdlePause.mockResolvedValue({ ...OFF, changed: true });
    open();

    await screen.findByText(/changed since idle pause was turned on/);
    expect(screen.getByRole("button", { name: "Turn on idle pause" }).hasAttribute("disabled")).toBe(
      false
    );
  });

  it("shows what the host has now when the commands changed before the confirm", async () => {
    worktreeClientMock.getIdlePause
      .mockResolvedValueOnce(OFF)
      .mockResolvedValueOnce({ ...OFF, commands: ["stop-box --force"], fingerprint: "b".repeat(64) });
    worktreeClientMock.setIdlePause.mockRejectedValueOnce(
      new Error("These pause commands changed after you reviewed them. Review them again.")
    );
    const onClose = open();

    await screen.findByText("stop-box {{worktree_name}}");
    fireEvent.click(screen.getByRole("button", { name: "Turn on idle pause" }));

    await screen.findByText("stop-box --force");
    expect(screen.getByRole("alert").textContent).toMatch(/changed after you reviewed/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("turns off without a fingerprint", async () => {
    worktreeClientMock.getIdlePause.mockResolvedValue({ ...OFF, enabled: true });
    open();

    fireEvent.click(await screen.findByRole("button", { name: "Turn off idle pause" }));

    await waitFor(() =>
      expect(worktreeClientMock.setIdlePause).toHaveBeenCalledWith("/wt", false, undefined)
    );
  });

  it("offers nothing for an environment from the repository", async () => {
    worktreeClientMock.getIdlePause.mockResolvedValue({
      status: "unavailable",
      reason: "repository",
      sourcePath: "/repo/.daintree/settings.json",
    });
    open();

    await screen.findByText(/comes from the repository/);
    expect(screen.getByRole("button", { name: "Turn on idle pause" }).hasAttribute("disabled")).toBe(
      true
    );
  });
});
