/**
 * @vitest-environment jsdom
 *
 * The follow-up after Save as project (#15004). The save is a copy, and the
 * scratch's terminals and agents keep writing to the original folder, so this
 * step must not offer to delete the scratch; it offers the saved project.
 *
 * `ConfirmDialog` is stubbed to a prop-rendering seam, as in the palette's
 * scratch-delete suite: its own gates have their own suite, and what matters
 * here is what this step hands it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/hooks/useSettingsOwner", () => ({
  useRemoteHostName: () => null,
}));

vi.mock("@/components/ui/ConfirmDialog", async () => {
  const { useEffect, useState } = await vi.importActual<typeof import("react")>("react");
  return {
    ConfirmDialog: ({
      isOpen,
      title,
      children,
      confirmLabel,
      cancelLabel,
      onConfirm,
      onClose,
      variant,
      restoreFocusTo,
    }: {
      isOpen: boolean;
      title: React.ReactNode;
      children?: React.ReactNode;
      confirmLabel: string;
      cancelLabel?: string;
      onConfirm: () => void;
      onClose?: () => void;
      variant: string;
      restoreFocusTo?: React.RefObject<HTMLElement | null>;
    }) => {
      // Resolved after mount: the ref is still null while the dialog renders.
      const [restoreTarget, setRestoreTarget] = useState("");
      useEffect(() => {
        setRestoreTarget(restoreFocusTo?.current?.getAttribute("data-testid") ?? "");
      }, [restoreFocusTo]);

      return isOpen ? (
        <div data-testid="confirm-dialog" data-variant={variant} data-restore-focus={restoreTarget}>
          <h2 data-testid="confirm-title">{title}</h2>
          <div data-testid="confirm-body">{children}</div>
          <button type="button" data-testid="confirm-accept" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" data-testid="confirm-cancel" onClick={onClose}>
            {cancelLabel}
          </button>
        </div>
      ) : null;
    },
  };
});

const { ProjectSwitcherConfirmDialogs } = await import("../ProjectSwitcherConfirmDialogs");

const followUp = {
  scratch: { name: "Retry spike" },
  project: { name: "retry-queue", path: "/Users/me/code/retry-queue" },
};

function renderFollowUp() {
  const onDismissSaveAsProjectConfirm = vi.fn();
  const onOpenSavedProject = vi.fn();
  const paletteInputRef = createRef<HTMLInputElement>();
  render(
    <>
      <input ref={paletteInputRef} data-testid="palette-input" />
      <ProjectSwitcherConfirmDialogs
        saveAsProjectConfirm={followUp}
        onDismissSaveAsProjectConfirm={onDismissSaveAsProjectConfirm}
        onOpenSavedProject={onOpenSavedProject}
        paletteInputRef={paletteInputRef}
      />
    </>
  );
  return { onDismissSaveAsProjectConfirm, onOpenSavedProject };
}

const DESTRUCTIVE_LABEL = /^\s*(delete|remove)\b/i;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Save as project follow-up", () => {
  it("offers the saved project rather than deleting the scratch", () => {
    renderFollowUp();

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog.getAttribute("data-variant")).not.toBe("destructive");
    expect(screen.getByTestId("confirm-accept").textContent).not.toMatch(DESTRUCTIVE_LABEL);
    expect(screen.getByTestId("confirm-cancel").textContent).not.toMatch(DESTRUCTIVE_LABEL);
    expect(screen.getByTestId("confirm-title").textContent).toContain(followUp.project.name);
    expect(screen.getByTestId("confirm-title").textContent).not.toContain(followUp.scratch.name);
  });

  it("names the scratch the copy came from and where the project lives", () => {
    renderFollowUp();

    const body = screen.getByTestId("confirm-body").textContent ?? "";
    expect(body).toContain(followUp.scratch.name);
    // PathSegments splits the path into crumbs, so check each segment arrives.
    for (const segment of followUp.project.path.split("/").filter(Boolean)) {
      expect(body).toContain(segment);
    }
  });

  it("opens the project on accept, and only closes on dismiss", () => {
    const { onDismissSaveAsProjectConfirm, onOpenSavedProject } = renderFollowUp();

    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(onDismissSaveAsProjectConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenSavedProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-accept"));
    expect(onOpenSavedProject).toHaveBeenCalledTimes(1);
  });

  it("forwards the palette input as the restore target, since it outlives the dialog", () => {
    renderFollowUp();

    expect(screen.getByTestId("confirm-dialog").getAttribute("data-restore-focus")).toBe(
      "palette-input"
    );
  });
});
