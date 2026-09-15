// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleCommandReview } from "@shared/types/worktree";

const worktreeClientMock = vi.hoisted(() => ({
  getLifecycleCommandReview: vi.fn(),
  approveLifecycleCommands: vi.fn(),
}));

vi.mock("@/clients", () => ({ worktreeClient: worktreeClientMock }));

// The dialog primitive has its own suite; this one is about what the approval
// dialog feeds it and does with the answer.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    isOpen: boolean;
    title: ReactNode;
    children?: ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    confirmDisabled?: boolean;
    isConfirmLoading?: boolean;
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
        <button
          type="button"
          disabled={props.confirmDisabled || props.isConfirmLoading}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { LifecycleCommandApprovalDialog } from "../LifecycleCommandApprovalDialog";

const REVIEW: LifecycleCommandReview = {
  fingerprint: "f".repeat(64),
  sources: [
    {
      path: "/repo/.daintree/config.json",
      groups: [
        { label: "Setup", commands: ["npm install", "./scripts/bootstrap.sh"] },
        { label: "Teardown", commands: ["docker compose down"] },
      ],
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderDialog(overrides: { setupAwaitingApproval?: boolean; onClose?: () => void } = {}) {
  return render(
    <LifecycleCommandApprovalDialog
      isOpen
      worktreeId="/repo-wt"
      setupAwaitingApproval={overrides.setupAwaitingApproval ?? false}
      onClose={overrides.onClose ?? (() => {})}
    />
  );
}

function approveButton(label = /approve/i): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

describe("LifecycleCommandApprovalDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps approval unavailable until the host's review has loaded", async () => {
    const pending = deferred<LifecycleCommandReview | null>();
    worktreeClientMock.getLifecycleCommandReview.mockReturnValue(pending.promise);

    renderDialog();
    expect(approveButton().disabled).toBe(true);

    await act(async () => pending.resolve(REVIEW));

    expect(approveButton().disabled).toBe(false);
    expect(worktreeClientMock.getLifecycleCommandReview).toHaveBeenCalledWith("/repo-wt");
  });

  it("shows the literal commands and the file they come from", async () => {
    worktreeClientMock.getLifecycleCommandReview.mockResolvedValue(REVIEW);

    renderDialog();

    expect(await screen.findByText("/repo/.daintree/config.json")).toBeDefined();
    const blocks = [...document.querySelectorAll("pre")].map((pre) => pre.textContent);
    expect(blocks).toEqual(["npm install\n./scripts/bootstrap.sh", "docker compose down"]);
  });

  it("approves exactly the fingerprint it displayed, then closes", async () => {
    worktreeClientMock.getLifecycleCommandReview.mockResolvedValue(REVIEW);
    worktreeClientMock.approveLifecycleCommands.mockResolvedValue(undefined);
    const onClose = vi.fn();

    renderDialog({ setupAwaitingApproval: true, onClose });
    await screen.findByText("/repo/.daintree/config.json");

    fireEvent.click(approveButton(/approve and run setup/i));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(worktreeClientMock.approveLifecycleCommands).toHaveBeenCalledWith(
      "/repo-wt",
      REVIEW.fingerprint
    );
  });

  it("stays open with the reason and re-reads the commands when approval is refused", async () => {
    const changed: LifecycleCommandReview = { ...REVIEW, fingerprint: "e".repeat(64) };
    worktreeClientMock.getLifecycleCommandReview
      .mockResolvedValueOnce(REVIEW)
      .mockResolvedValueOnce(changed);
    worktreeClientMock.approveLifecycleCommands.mockRejectedValue(
      new Error("These commands changed after you reviewed them. Review them again.")
    );
    const onClose = vi.fn();

    renderDialog({ onClose });
    await screen.findByText("/repo/.daintree/config.json");
    fireEvent.click(approveButton());

    expect((await screen.findByRole("alert")).textContent).toMatch(/changed/);
    await waitFor(() =>
      expect(worktreeClientMock.getLifecycleCommandReview).toHaveBeenCalledTimes(2)
    );
    expect(onClose).not.toHaveBeenCalled();

    worktreeClientMock.approveLifecycleCommands.mockResolvedValue(undefined);
    await waitFor(() => expect(approveButton().disabled).toBe(false));
    fireEvent.click(approveButton());
    await waitFor(() =>
      expect(worktreeClientMock.approveLifecycleCommands).toHaveBeenLastCalledWith(
        "/repo-wt",
        changed.fingerprint
      )
    );
  });

  it("offers nothing to approve when the commands no longer need it", async () => {
    worktreeClientMock.getLifecycleCommandReview.mockResolvedValue(null);

    renderDialog();

    expect(await screen.findByText(/nothing is waiting for approval/i)).toBeDefined();
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });

  it("reports a review that could not be read instead of an empty list", async () => {
    worktreeClientMock.getLifecycleCommandReview.mockRejectedValue(new Error("Worktree not found"));

    renderDialog();

    expect((await screen.findByRole("alert")).textContent).toMatch(/Worktree not found/);
    expect(approveButton().disabled).toBe(true);
  });
});
