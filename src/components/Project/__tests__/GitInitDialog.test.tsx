/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { GitInitProgressEvent } from "@shared/types/ipc/gitInit";

const { initGitGuidedMock, onInitGitProgressMock } = vi.hoisted(() => ({
  initGitGuidedMock: vi.fn(),
  onInitGitProgressMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    initGitGuided: initGitGuidedMock,
    onInitGitProgress: onInitGitProgressMock,
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/AppDialog", () => {
  interface AppDialogMockProps {
    isOpen: boolean;
    children: ReactNode;
    onClose: () => void;
    dismissible?: boolean;
  }

  interface AppDialogSectionProps {
    children: ReactNode;
  }

  const AppDialog = ({ isOpen, children, onClose, dismissible = true }: AppDialogMockProps) =>
    isOpen ? (
      <div data-testid="app-dialog" data-dismissible={dismissible ? "true" : "false"}>
        <button type="button" onClick={onClose}>
          dialog-close
        </button>
        {children}
      </div>
    ) : null;

  AppDialog.Header = ({ children }: AppDialogSectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: AppDialogSectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.Body = ({ children }: AppDialogSectionProps) => <div>{children}</div>;

  return { AppDialog };
});

import { GitInitDialog } from "../GitInitDialog";

describe("GitInitDialog", () => {
  let progressHandler: ((event: GitInitProgressEvent) => void) | null = null;
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    vi.clearAllMocks();
    progressHandler = null;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    onInitGitProgressMock.mockImplementation((callback: (event: GitInitProgressEvent) => void) => {
      progressHandler = callback;
      return vi.fn();
    });

    initGitGuidedMock.mockResolvedValue({ success: true, completedSteps: [] });
  });

  afterEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  });

  it("starts guided initialization when opened", async () => {
    initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));

    render(
      <GitInitDialog
        isOpen={true}
        directoryPath="/tmp/new-repo"
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(initGitGuidedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          directoryPath: "/tmp/new-repo",
          createInitialCommit: true,
          createGitignore: true,
          gitignoreTemplate: "node",
        })
      );
    });

    const dialog = screen.getByTestId("app-dialog");
    expect(dialog.getAttribute("data-dismissible")).toBe("false");
  });

  it("auto-continues after completion event", async () => {
    const onSuccess = vi.fn();
    render(
      <GitInitDialog
        isOpen={true}
        directoryPath="/tmp/new-repo"
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />
    );

    await waitFor(() => expect(progressHandler).not.toBeNull());

    act(() => {
      progressHandler?.({
        step: "complete",
        status: "success",
        message: "Git initialization complete",
        timestamp: Date.now(),
      });
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });
});
