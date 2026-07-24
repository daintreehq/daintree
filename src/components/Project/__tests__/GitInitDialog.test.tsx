/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { GitInitProgressEvent } from "@shared/types/ipc/gitInit";
import {
  GITIGNORE_TEMPLATE_OPTIONS,
  DEFAULT_GITIGNORE_TEMPLATE_ID,
} from "@shared/config/gitignoreTemplates";

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

    initGitGuidedMock.mockResolvedValue({ outcome: "success", completedSteps: [] });
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

    const button = screen.getByRole("button", {
      name: /initialize repository/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(initGitGuidedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          directoryPath: "/tmp/new-repo",
          createInitialCommit: true,
          createGitignore: true,
          gitignoreTemplate: DEFAULT_GITIGNORE_TEMPLATE_ID,
          initialCommitMessage: "feat: init",
        })
      );
    });
  });

  it("offers every registry template in order and preselects the default", () => {
    renderDialog();

    const select = screen.getByLabelText(/gitignore template/i) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(
      GITIGNORE_TEMPLATE_OPTIONS.map((option) => option.value)
    );
    expect(select.value).toBe(DEFAULT_GITIGNORE_TEMPLATE_ID);
  });

  it("pre-fills the commit message and submits the default without editing", async () => {
    renderDialog();

    const input = screen.getByLabelText(/initial commit message/i) as HTMLInputElement;
    expect(input.value).toBe("Initial commit");

    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(initGitGuidedMock).toHaveBeenCalledWith(
        expect.objectContaining({ initialCommitMessage: "Initial commit" })
      );
    });
  });

  it("disables submit when the commit message is cleared", () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "   " },
    });

    const button = screen.getByRole("button", {
      name: /initialize repository/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(initGitGuidedMock).not.toHaveBeenCalled();
  });

  it("resets the commit message and template to the defaults when reopened", () => {
    const onSuccess = vi.fn();
    const onCancel = vi.fn();
    const dialogProps = {
      directoryPath: "/tmp/new-repo",
      onSuccess,
      onCancel,
    };
    const { rerender } = render(<GitInitDialog isOpen={true} {...dialogProps} />);

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: custom" },
    });
    fireEvent.change(screen.getByLabelText(/gitignore template/i), {
      target: { value: "python" },
    });

    rerender(<GitInitDialog isOpen={false} {...dialogProps} />);
    rerender(<GitInitDialog isOpen={true} {...dialogProps} />);

    const input = screen.getByLabelText(/initial commit message/i) as HTMLInputElement;
    expect(input.value).toBe("Initial commit");
    const select = screen.getByLabelText(/gitignore template/i) as HTMLSelectElement;
    expect(select.value).toBe(DEFAULT_GITIGNORE_TEMPLATE_ID);
  });

  it("clears the missing-status warning when a late success event arrives", async () => {
    // The invoke resolves without a "success" outcome and no terminal event,
    // so the dialog shows the missing-status warning until a late event arrives.
    initGitGuidedMock.mockResolvedValueOnce({ outcome: "error", completedSteps: [] });
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(screen.getByText(/without a status update/i)).toBeTruthy();
    });

    act(() => {
      progressHandler?.({
        step: "complete",
        status: "success",
        message: "Git initialization complete",
        timestamp: Date.now(),
      });
    });

    await waitFor(() => {
      expect(screen.queryByText(/without a status update/i)).toBeNull();
      expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
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

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    const button = screen.getByRole("button", { name: /initialize repository/i });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(initGitGuidedMock).toHaveBeenCalledTimes(1));
  });

  it("auto-continues after a completion event", async () => {
    const onSuccess = vi.fn();
    renderDialog({ onSuccess });

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
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

  it("auto-continues from a completion event while the invoke is still pending", async () => {
    initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));
    const onSuccess = vi.fn();
    renderDialog({ onSuccess });

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
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

  it("ignores a stray success event after an error event", async () => {
    initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));
    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));
    await waitFor(() => expect(progressHandler).not.toBeNull());

    act(() => {
      progressHandler?.({
        step: "complete",
        status: "error",
        message: "Repository initialized — initial commit skipped",
        error: "identity not configured",
        timestamp: Date.now(),
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    });

    act(() => {
      progressHandler?.({
        step: "complete",
        status: "success",
        message: "Git initialization complete",
        timestamp: Date.now(),
      });
    });

    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("recovers cleanly when a retry succeeds", async () => {
    initGitGuidedMock.mockResolvedValueOnce({ outcome: "error", completedSteps: [] });
    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(screen.getByText(/finished without a status update/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
    });
    expect(screen.queryByText(/finished without a status update/i)).toBeNull();
    expect(screen.queryByText(/initialization failed/i)).toBeNull();
  });

  it("completes from the invoke result when no progress events arrive", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
    });
    expect(screen.queryByText(/initialization failed/i)).toBeNull();
  });

  it("shows the fallback error when init resolves unsuccessfully without a status event", async () => {
    initGitGuidedMock.mockResolvedValue({ outcome: "error", completedSteps: [] });

    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(screen.getByText(/finished without a status update/i)).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("clears a stale fallback error when the success event arrives late", async () => {
    initGitGuidedMock.mockResolvedValue({ outcome: "error", completedSteps: [] });

    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(screen.getByText(/finished without a status update/i)).toBeTruthy();
    });

    act(() => {
      progressHandler?.({
        step: "complete",
        status: "success",
        message: "Git initialization complete",
        timestamp: Date.now(),
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
    });
    expect(screen.queryByText(/finished without a status update/i)).toBeNull();
    expect(screen.queryByText(/initialization failed/i)).toBeNull();
  });

  it("keeps the specific identity error when init resolves unsuccessfully after error events", async () => {
    const identityHelp =
      "Set your git identity, then create the initial commit manually:\n" +
      '  git config --global user.name "Your Name"\n' +
      '  git config --global user.email "you@example.com"';

    initGitGuidedMock.mockImplementationOnce(() => {
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
      return Promise.resolve({ outcome: "error", completedSteps: ["init", "gitignore", "add"] });
    });

    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/git config --global user\.name/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/finished without a status update/i)).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("surfaces the git config commands and offers Try again on identity error", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
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

  describe("project identity row", () => {
    function nameInput() {
      return screen.getByLabelText(/project name/i) as HTMLInputElement;
    }

    it("derives the name from the folder when reached without a carried identity", () => {
      renderDialog();
      expect(nameInput().value).toBe("new-repo");
    });

    it("prefills from the identity chosen one dialog earlier instead of re-deriving", () => {
      render(
        <GitInitDialog
          isOpen={true}
          directoryPath="/tmp/new-repo"
          initialIdentity={{ name: "Chosen Name", emoji: "🚀" }}
          onSuccess={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      expect(nameInput().value).toBe("Chosen Name");
      expect(screen.getByRole("button", { name: /choose project emoji/i }).textContent).toBe("🚀");
    });

    it("blocks initialization while the name is empty", () => {
      renderDialog();
      fireEvent.change(nameInput(), { target: { value: "   " } });

      const start = screen.getByRole("button", { name: /initialize repository/i });
      expect((start as HTMLButtonElement).disabled).toBe(true);
    });

    it("reports the edited identity on success", async () => {
      const onSuccess = vi.fn();
      renderDialog({ onSuccess });

      fireEvent.change(nameInput(), { target: { value: "  Renamed  " } });
      fireEvent.click(screen.getByRole("button", { name: /initialize repository/i }));

      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(onSuccess).toHaveBeenCalledWith({
        name: "Renamed",
        emoji: expect.any(String) as unknown as string,
      });
    });

    it("re-seeds the identity when reopened for a different folder", () => {
      const props = { onSuccess: vi.fn(), onCancel: vi.fn() };
      const { rerender } = render(
        <GitInitDialog isOpen={true} directoryPath="/tmp/first-folder" {...props} />
      );
      expect(nameInput().value).toBe("first-folder");

      rerender(<GitInitDialog isOpen={false} directoryPath="/tmp/first-folder" {...props} />);
      rerender(<GitInitDialog isOpen={true} directoryPath="/tmp/second-folder" {...props} />);

      expect(nameInput().value).toBe("second-folder");
    });
  });
});
