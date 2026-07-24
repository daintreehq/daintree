/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";
import type { Project } from "@shared/types";

const { updateProjectMock } = vi.hoisted(() => ({ updateProjectMock: vi.fn() }));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ updateProject: updateProjectMock }),
}));

// Render popover content inline — this test is about the editing contract, not
// Radix's positioning.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, ...rest }: { children: ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
}));

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
  return screen.getByLabelText(/project name/i) as HTMLInputElement;
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

    it("stamps the popover content so the switcher's outside-click guard can spot it", () => {
      const { container } = render(<ProjectIdentityEditor project={makeProject()} />);
      expect(container.querySelector("[data-project-identity-popover]")).not.toBeNull();
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
      fireEvent.keyDown(nameField(), { key: "Escape" });

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
  });
});
