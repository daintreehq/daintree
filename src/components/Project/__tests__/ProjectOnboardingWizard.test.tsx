// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProjectOnboardingWizard } from "../ProjectOnboardingWizard";

const mockUpdateProject = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("@/hooks", () => ({
  useProjectSettings: vi.fn(() => ({
    settings: {
      devServerCommand: "",
      runCommands: [],
    },
    saveSettings: mockSaveSettings,
    isLoading: false,
  })),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: vi.fn(() => ({
    projects: [
      {
        id: "test-project",
        name: "Test Project",
        emoji: "🌲",
        color: "#10b981",
      },
    ],
    updateProject: mockUpdateProject,
  })),
}));

vi.mock("@/components/ui/AppDialog", () => {
  const MockAppDialog = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-dialog">{children}</div>
  );

  MockAppDialog.Body = function MockAppDialogBody({ children }: { children: React.ReactNode }) {
    return <div data-testid="dialog-body">{children}</div>;
  };

  MockAppDialog.Footer = function MockAppDialogFooter({ children }: { children: React.ReactNode }) {
    return <div data-testid="dialog-footer">{children}</div>;
  };

  return {
    AppDialog: MockAppDialog,
  };
});

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: () => <div data-testid="emoji-picker" />,
}));

vi.mock("@/components/ui/ScrollShadow", () => ({
  ScrollShadow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/Spinner", () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

describe("ProjectOnboardingWizard", () => {
  const mockOnClose = vi.fn();
  const mockOnFinish = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveSettings.mockResolvedValue(undefined);
    mockUpdateProject.mockResolvedValue(undefined);
  });

  it("renders with initial project data", () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    expect(screen.getByText("Set up your project")).toBeTruthy();
    expect(screen.getByDisplayValue("Test Project")).toBeTruthy();
    expect(screen.getByText("🌲")).toBeTruthy();
  });

  it("shows randomize button next to emoji", () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    const randomizeBtn = screen.getByLabelText("Randomize emoji");
    expect(randomizeBtn).toBeTruthy();
  });

  it("changes emoji to different value on randomize click", () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    const emojiBefore = screen.getByText("🌲");
    expect(emojiBefore).toBeTruthy();

    const randomizeBtn = screen.getByLabelText("Randomize emoji");
    fireEvent.click(randomizeBtn);

    const emojiAfter = screen.getByText((content, element) => {
      return element?.tagName === "SPAN" && content !== "🌲";
    });
    expect(emojiAfter).toBeTruthy();
    expect(emojiAfter.textContent).not.toBe("🌲");
  });

  it("never repeats the current emoji on randomize click", () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    const randomizeBtn = screen.getByLabelText("Randomize emoji");

    for (let i = 0; i < 20; i++) {
      const currentEmoji = screen.getByText((_, element) => {
        return element?.tagName === "SPAN";
      }).textContent;

      fireEvent.click(randomizeBtn);

      const newEmoji = screen.getByText((_, element) => {
        return element?.tagName === "SPAN";
      }).textContent;

      expect(newEmoji).not.toBe(currentEmoji);
    }
  });

  it("cycles through all curated emojis before repeating", () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    const randomizeBtn = screen.getByLabelText("Randomize emoji");
    const seenEmojis = new Set<string>();
    const initialEmoji = "🌲";

    // Get the emoji before first click
    const initialEmojiSpan = screen.getByText((_, element) => {
      return element?.tagName === "SPAN";
    });
    expect(initialEmojiSpan.textContent).toBe(initialEmoji);

    for (let i = 0; i < 19; i++) {
      fireEvent.click(randomizeBtn);
      const emojiSpan = screen.getByText((_, element) => {
        return element?.tagName === "SPAN";
      });
      seenEmojis.add(emojiSpan.textContent || "");
    }

    expect(seenEmojis.size).toBe(19);
    expect(seenEmojis.has(initialEmoji)).toBe(false);
  });

  it("calls handleFinish when Enter is pressed in project name input", async () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    const nameInput = screen.getByLabelText("Project Name");
    fireEvent.change(nameInput, { target: { value: "New Name" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    await waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          runCommands: [],
        })
      );
    });
    await waitFor(() => {
      expect(mockUpdateProject).toHaveBeenCalledWith("test-project", {
        name: "New Name",
        emoji: "🌲",
      });
    });
  });

  it("does not trigger save when Enter is pressed in dev server input", () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    // Expand Advanced section
    const advancedButton = screen.getByText("Advanced Configuration");
    fireEvent.click(advancedButton);

    const devServerInput = screen.getByLabelText("Dev server command");
    fireEvent.keyDown(devServerInput, { key: "Enter" });

    expect(mockOnFinish).not.toHaveBeenCalled();
    expect(mockOnClose).not.toHaveBeenCalled();
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  it("does not trigger save when Enter is pressed in run command name input", () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    // Expand Advanced section
    const advancedButton = screen.getByText("Advanced Configuration");
    fireEvent.click(advancedButton);

    const addCommandBtn = screen.getByText("Add Command");
    fireEvent.click(addCommandBtn);

    const nameInput = screen.getByLabelText("Run command name");
    fireEvent.keyDown(nameInput, { key: "Enter" });

    expect(mockOnFinish).not.toHaveBeenCalled();
    expect(mockOnClose).not.toHaveBeenCalled();
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  it("does not trigger save when Enter is pressed in run command input", () => {
    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    // Expand Advanced section
    const advancedButton = screen.getByText("Advanced Configuration");
    fireEvent.click(advancedButton);

    const addCommandBtn = screen.getByText("Add Command");
    fireEvent.click(addCommandBtn);

    const commandInput = screen.getByLabelText("Run command");
    fireEvent.keyDown(commandInput, { key: "Enter" });

    expect(mockOnFinish).not.toHaveBeenCalled();
    expect(mockOnClose).not.toHaveBeenCalled();
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  it("blocks double Enter submission while saving", async () => {
    let resolveSave: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    mockSaveSettings.mockReturnValue(savePromise);

    render(
      <ProjectOnboardingWizard
        isOpen
        projectId="test-project"
        onClose={mockOnClose}
        onFinish={mockOnFinish}
      />
    );

    const nameInput = screen.getByLabelText("Project Name");
    fireEvent.keyDown(nameInput, { key: "Enter" });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    await waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    });
    expect(mockUpdateProject).toHaveBeenCalledTimes(0);
    resolveSave!();
  });
});
