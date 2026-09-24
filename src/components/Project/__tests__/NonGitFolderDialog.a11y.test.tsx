/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The sibling suite mocks `AppDialog` away to test the step machine. This one
// renders the real primitive, because what it pins lives in the wiring between
// the two: the description association, and which control holds focus on arrival.

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

vi.mock("../GitInitDialog", () => ({
  GitInitDialog: () => <div data-testid="git-init-dialog" />,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

import { NonGitFolderDialog } from "../NonGitFolderDialog";

function renderDialog() {
  const props = {
    isOpen: true,
    directoryPath: "/Users/someone/Downloads/archive",
    initialStep: "choice" as const,
    onOpenWithoutGit: vi.fn(),
    onInitSuccess: vi.fn(),
    onCancel: vi.fn(),
  };
  render(<NonGitFolderDialog {...props} />);
  return props;
}

function footerActions(): HTMLButtonElement[] {
  const dialog = screen.getByRole("dialog");
  return Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) => button.getAttribute("aria-label") === null
  );
}

describe("NonGitFolderDialog — real dialog wiring", () => {
  it("describes itself with text that is actually rendered", () => {
    renderDialog();

    const describedBy = screen.getByRole("dialog").getAttribute("aria-describedby");
    const description = describedBy ? document.getElementById(describedBy) : null;

    expect(description).not.toBeNull();
    expect(description!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it("arrives on the answer that writes nothing into the folder", async () => {
    const props = renderDialog();

    await waitFor(() => {
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    });
    // Whatever the arrival control is, a reflexive Enter/Space on it must adopt
    // the folder as-is — never start git setup, and never throw the choice away.
    const arrival = document.activeElement;
    if (!(arrival instanceof HTMLElement)) throw new Error("nothing focused on arrival");
    arrival.click();

    expect(props.onOpenWithoutGit).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("git-init-dialog")).toBeNull();
  });

  it("explains every answer it offers, under the answer's own name", () => {
    renderDialog();

    const explained = Array.from(document.querySelectorAll("dt")).map((dt) =>
      dt.textContent!.trim()
    );
    const answers = footerActions()
      .filter((button) => button.dataset.confirmRole !== "cancel")
      .map((button) => button.textContent!.trim());

    expect(answers.length).toBeGreaterThan(1);
    expect(explained.sort()).toEqual(answers.sort());
  });

  it("attaches each answer's consequence to the button that chooses it", () => {
    renderDialog();

    const explanations = new Map(
      Array.from(document.querySelectorAll("dt")).map((dt) => [
        dt.textContent!.trim(),
        dt.nextElementSibling,
      ])
    );
    const answers = footerActions().filter((button) => button.dataset.confirmRole !== "cancel");

    for (const button of answers) {
      const describedBy = button.getAttribute("aria-describedby");
      const description = describedBy ? document.getElementById(describedBy) : null;
      expect(description).not.toBeNull();
      expect(description).toBe(explanations.get(button.textContent!.trim()));
    }
  });

  it("offers a visible way out that chooses neither answer", () => {
    const props = renderDialog();

    const cancel = footerActions().find((button) => button.dataset.confirmRole === "cancel");
    expect(cancel).toBeDefined();
    fireEvent.click(cancel!);

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onOpenWithoutGit).not.toHaveBeenCalled();
  });
});
