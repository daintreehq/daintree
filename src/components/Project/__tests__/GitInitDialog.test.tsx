/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
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
  AppDialog.Footer = ({ children }: AppDialogSectionProps) => <div>{children}</div>;

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

  function renderDialog(overrides: { onSuccess?: () => void; onCancel?: () => void } = {}) {
    return render(
      <GitInitDialog
        isOpen={true}
        directoryPath="/tmp/new-repo"
        onSuccess={overrides.onSuccess ?? vi.fn()}
        onCancel={overrides.onCancel ?? vi.fn()}
      />
    );
  }

  it("does not auto-fire on mount and waits for the user to confirm", async () => {
    renderDialog();

    // Listener registered, but no IPC call happens until the user clicks.
    await waitFor(() => expect(onInitGitProgressMock).toHaveBeenCalled());
    expect(initGitGuidedMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(initGitGuidedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          directoryPath: "/tmp/new-repo",
          createInitialCommit: true,
          createGitignore: true,
          gitignoreTemplate: "node",
          initialCommitMessage: "Initial commit",
        })
      );
    });
  });

  it("passes the selected template and edited commit message", async () => {
    initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));

    renderDialog();

    fireEvent.change(screen.getByLabelText(/gitignore template/i), {
      target: { value: "python" },
    });
    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: bootstrap" },
    });

    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(initGitGuidedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          gitignoreTemplate: "python",
          initialCommitMessage: "feat: bootstrap",
        })
      );
    });
  });

  it("hides the commit message field and skips the initial commit when unchecked", async () => {
    initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));

    renderDialog();

    fireEvent.click(screen.getByLabelText(/create initial commit/i));
    expect(screen.queryByLabelText(/initial commit message/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(initGitGuidedMock).toHaveBeenCalledWith(
        expect.objectContaining({ createInitialCommit: false })
      );
    });
  });

  it("skips .gitignore creation when template is 'none'", async () => {
    initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));

    renderDialog();

    fireEvent.change(screen.getByLabelText(/gitignore template/i), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(initGitGuidedMock).toHaveBeenCalledWith(
        expect.objectContaining({ createGitignore: false, gitignoreTemplate: "none" })
      );
    });
  });

  it("guards against double-clicks dispatching two IPC calls", async () => {
    initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));

    renderDialog();

    const button = screen.getByRole("button", { name: /initialize repository/i });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(initGitGuidedMock).toHaveBeenCalledTimes(1));
  });

  it("auto-continues after a completion event", async () => {
    const onSuccess = vi.fn();
    renderDialog({ onSuccess });

    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));
    await waitFor(() => expect(progressHandler).not.toBeNull());

    act(() => {
      progressHandler?.({
        step: "complete",
        status: "success",
        message: "Git initialization complete",
        timestamp: Date.now(),
      });
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it("surfaces the git config commands and offers Try again on identity error", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));
    await waitFor(() => expect(progressHandler).not.toBeNull());

    const identityHelp =
      "Set your git identity, then create the initial commit manually:\n" +
      '  git config --global user.name "Your Name"\n' +
      '  git config --global user.email "you@example.com"';

    act(() => {
      progressHandler?.({
        step: "commit",
        status: "error",
        message: "Git user identity not configured",
        error: identityHelp,
        timestamp: Date.now(),
      });
      progressHandler?.({
        step: "complete",
        status: "error",
        message: "Repository initialized — initial commit skipped",
        error: identityHelp,
        timestamp: Date.now(),
      });
    });

    await waitFor(() => {
      expect(screen.getAllByText(/git config --global user\.name/i).length).toBeGreaterThan(0);
    });

    initGitGuidedMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(initGitGuidedMock).toHaveBeenCalledTimes(1));
  });
});
