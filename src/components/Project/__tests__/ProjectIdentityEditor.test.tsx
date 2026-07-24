/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import type { Project } from "@shared/types";

const { updateProjectMock } = vi.hoisted(() => ({ updateProjectMock: vi.fn() }));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ updateProject: updateProjectMock }),
}));

// Render popover content inline — this test is about the editing contract, not
// Radix's positioning. `onEscapeKeyDown` is captured rather than swallowed:
// Radix fires it from a document CAPTURE listener BEFORE the input's own
// keydown, and the cancel-vs-commit ordering hangs on that. A mock that dropped
// it would let a broken Escape path pass while production saved the edit.
let escapeKeyDownHandler: ((event: { preventDefault: () => void }) => void) | null = null;

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    onEscapeKeyDown,
    onOpenAutoFocus: _onOpenAutoFocus,
    ...rest
  }: {
    children: ReactNode;
    onEscapeKeyDown?: (event: { preventDefault: () => void }) => void;
    onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
  }) => {
    escapeKeyDownHandler = onEscapeKeyDown ?? null;
    return <div {...rest}>{children}</div>;
  },
}));

/** Drive Escape the way Radix does — via the content handler, not the input. */
function pressEscape(): boolean {
  let defaultPrevented = false;
  // Invoked directly rather than through fireEvent, so the state updates it
  // makes need an explicit act().
  act(() => {
    escapeKeyDownHandler?.({
      preventDefault: () => {
        defaultPrevented = true;
      },
    });
  });
  return defaultPrevented;
}

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({ onEmojiSelect }: { onEmojiSelect: (e: { emoji: string }) => void }) => (
    <button type="button" onClick={() => onEmojiSelect({ emoji: "🦄" })}>
      pick-unicorn
    </button>
  ),
}));

import { ProjectIdentityEditor } from "../ProjectIdentityEditor";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    path: "/repos/my-api",
    name: "my-api",
    emoji: DEFAULT_PROJECT_EMOJI,
    lastOpened: 0,
    ...overrides,
  };
}

function nameField() {
  return screen.getByLabelText<HTMLInputElement>(/project name/i);
}

describe("ProjectIdentityEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateProjectMock.mockResolvedValue(undefined);
  });

  describe("markup contract", () => {
    it("renders the trigger as a standalone button, never nesting one inside another", () => {
      const { container } = render(<ProjectIdentityEditor project={makeProject()} />);
      // A nested <button> inside a <button> is invalid HTML and fires both
      // handlers on one click — the #6928 failure mode.
      expect(container.querySelector("button button")).toBeNull();
    });

    it("names the popover so it is not announced as a bare dialog", () => {
      render(<ProjectIdentityEditor project={makeProject()} />);
      expect(screen.getByLabelText("Edit project identity")).not.toBeNull();
    });
  });

  describe("emoji", () => {
    it("persists an emoji picked from the full picker", () => {
      render(<ProjectIdentityEditor project={makeProject()} />);

      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { emoji: "🦄" });
    });

    it("offers the name-derived suggestion while the project still shows the tree", () => {
      render(<ProjectIdentityEditor project={makeProject({ name: "my-api" })} />);

      const suggested = screen.getByRole("button", { name: /use suggested/i });
      fireEvent.click(suggested);

      expect(updateProjectMock).toHaveBeenCalledWith("p1", {
        emoji: suggestProjectEmoji("my-api"),
      });
    });

    it("hides the suggestion once the project has a non-default emoji", () => {
      render(<ProjectIdentityEditor project={makeProject({ emoji: "🚀" })} />);

      expect(screen.queryByRole("button", { name: /use suggested/i })).toBeNull();
    });

    it("does not write when the picked emoji already matches", () => {
      render(<ProjectIdentityEditor project={makeProject({ emoji: "🦄" })} />);

      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(updateProjectMock).not.toHaveBeenCalled();
    });

    it("carries a pending name edit along when an emoji is picked", () => {
      render(<ProjectIdentityEditor project={makeProject()} />);

      fireEvent.change(nameField(), { target: { value: "Renamed" } });
      // Picking closes the popover programmatically, which does NOT fire
      // onOpenChange — so this write is the only chance the rename gets.
      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(updateProjectMock).toHaveBeenCalledTimes(1);
      expect(updateProjectMock).toHaveBeenCalledWith("p1", {
        name: "Renamed",
        emoji: "🦄",
      });
    });

    it("suggests from the edited draft, not the committed name", () => {
      render(<ProjectIdentityEditor project={makeProject({ name: "plain" })} />);

      fireEvent.change(nameField(), { target: { value: "docs" } });
      fireEvent.click(screen.getByRole("button", { name: /use suggested/i }));

      expect(updateProjectMock).toHaveBeenCalledWith("p1", {
        name: "docs",
        emoji: suggestProjectEmoji("docs"),
      });
    });
  });

  describe("name", () => {
    it("commits a renamed project on Enter", () => {
      render(<ProjectIdentityEditor project={makeProject()} />);

      fireEvent.change(nameField(), { target: { value: "Renamed" } });
      fireEvent.keyDown(nameField(), { key: "Enter" });

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { name: "Renamed" });
    });

    it("trims before committing", () => {
      render(<ProjectIdentityEditor project={makeProject()} />);

      fireEvent.change(nameField(), { target: { value: "   Spaced   " } });
      fireEvent.keyDown(nameField(), { key: "Enter" });

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { name: "Spaced" });
    });

    it("treats an emptied field as no change rather than erasing the name", () => {
      render(<ProjectIdentityEditor project={makeProject()} />);

      fireEvent.change(nameField(), { target: { value: "   " } });
      fireEvent.keyDown(nameField(), { key: "Enter" });

      expect(updateProjectMock).not.toHaveBeenCalled();
      expect(nameField().value).toBe("my-api");
    });

    it("does not write when the name is unchanged", () => {
      render(<ProjectIdentityEditor project={makeProject()} />);

      fireEvent.keyDown(nameField(), { key: "Enter" });

      expect(updateProjectMock).not.toHaveBeenCalled();
    });

    it("reverts the draft on Escape without writing", () => {
      render(<ProjectIdentityEditor project={makeProject()} />);

      fireEvent.change(nameField(), { target: { value: "Abandoned" } });
      // Radix dismisses on Escape by default, which would run the close-commit
      // before any revert; the cancel path must take the close over itself.
      expect(pressEscape()).toBe(true);

      expect(updateProjectMock).not.toHaveBeenCalled();
      expect(nameField().value).toBe("my-api");
    });

    it("re-seeds the draft when the project changes underneath it", () => {
      const { rerender } = render(<ProjectIdentityEditor project={makeProject()} />);
      fireEvent.change(nameField(), { target: { value: "Draft" } });

      rerender(<ProjectIdentityEditor project={makeProject({ id: "p2", name: "other" })} />);

      // A stale draft must never be committable against a different project.
      expect(nameField().value).toBe("other");
    });

    it("does not write an untouched draft over a rename from elsewhere", () => {
      const { rerender } = render(<ProjectIdentityEditor project={makeProject({ name: "A" })} />);
      // Same project id, renamed in another window while this sat open and
      // untouched. Closing must not resurrect the old name.
      rerender(<ProjectIdentityEditor project={makeProject({ name: "B" })} />);

      fireEvent.click(screen.getByText("pick-unicorn"));

      expect(updateProjectMock).toHaveBeenCalledWith("p1", { emoji: "🦄" });
    });
  });
});
