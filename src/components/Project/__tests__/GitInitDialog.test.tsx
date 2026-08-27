/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { GitInitProgressEvent } from "@shared/types/ipc/gitInit";
import {
  GITIGNORE_TEMPLATE_OPTIONS,
  DEFAULT_GITIGNORE_TEMPLATE_ID,
} from "@shared/config/gitignoreTemplates";
import { suggestProjectEmoji } from "@shared/utils/projectEmoji";

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

// `CopyableCommand` — the house component that now carries the git-identity
// recovery lines — wraps its copy button in a Radix tooltip, which throws
// outside a provider. In the app the provider is App.tsx's, above ModalHostLayer.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
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

// `InlineStatusBanner` — the failure treatment this dialog now shares with the
// rest of the app — reads `prefers-reduced-motion` on render, and jsdom ships no
// `matchMedia`. Same shim the other banner suites use.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

/**
 * Queried by their role in the dialog's mode, not by their label. "Try again"
 * became "Retry" and "Continue" became "Open project" during the design pass,
 * and a test that pins the words re-breaks on every copy change while proving
 * nothing about behaviour.
 */
const startButton = () => screen.getByTestId<HTMLButtonElement>("git-init-start");
const retryButton = () => screen.getByTestId<HTMLButtonElement>("git-init-retry");

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

  function renderDialog(
    overrides: {
      onSuccess?: () => void;
      onCancel?: () => void;
      directoryPath?: string;
    } = {}
  ) {
    return render(
      <GitInitDialog
        isOpen={true}
        directoryPath={overrides.directoryPath ?? "/tmp/new-repo"}
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

    const button = startButton();
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

  // The caption renders as two spans so a deep path ellipsizes its ancestors
  // instead of its leaf. Measuring the leaf against a normalized path while
  // slicing it out of the raw one duplicated characters into the visible text.
  it.each([
    ["/tmp/projects/new-repo", "/tmp/projects/new-repo"],
    ["/tmp/projects/new-repo/", "/tmp/projects/new-repo"],
    ["/tmp/projects/new-repo/.", "/tmp/projects/new-repo"],
    ["C:\\projects\\new-repo\\", "C:/projects/new-repo"],
  ])(
    "renders %s as the destination path with no dropped or duplicated characters",
    (directoryPath, expected) => {
      renderDialog({ directoryPath });

      expect(screen.getByTitle(expected).textContent).toBe(expected);
    }
  );

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

    fireEvent.click(startButton());

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

    const button = startButton();
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

    fireEvent.click(startButton());

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
      expect(screen.getByTestId("git-init-open")).toBeTruthy();
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

    fireEvent.click(startButton());

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

    fireEvent.click(startButton());

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
    fireEvent.click(startButton());

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
    const button = startButton();
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
    fireEvent.click(startButton());
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
    fireEvent.click(startButton());
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
    fireEvent.click(startButton());
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
      expect(retryButton()).toBeTruthy();
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
    expect(retryButton()).toBeTruthy();
  });

  it("recovers cleanly when a retry succeeds", async () => {
    initGitGuidedMock.mockResolvedValueOnce({ outcome: "error", completedSteps: [] });
    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(startButton());

    await waitFor(() => {
      expect(screen.getByText(/finished without a status update/i)).toBeTruthy();
    });

    fireEvent.click(retryButton());

    await waitFor(() => {
      expect(screen.getByTestId("git-init-open")).toBeTruthy();
    });
    expect(screen.queryByText(/finished without a status update/i)).toBeNull();
    expect(screen.queryByText(/initialization failed/i)).toBeNull();
  });

  it("completes from the invoke result when no progress events arrive", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(startButton());

    await waitFor(() => {
      expect(screen.getByTestId("git-init-open")).toBeTruthy();
    });
    expect(screen.queryByText(/initialization failed/i)).toBeNull();
  });

  it("shows the fallback error when init resolves unsuccessfully without a status event", async () => {
    initGitGuidedMock.mockResolvedValue({ outcome: "error", completedSteps: [] });

    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(startButton());

    await waitFor(() => {
      expect(screen.getByText(/finished without a status update/i)).toBeTruthy();
    });
    expect(retryButton()).toBeTruthy();
  });

  it("clears a stale fallback error when the success event arrives late", async () => {
    initGitGuidedMock.mockResolvedValue({ outcome: "error", completedSteps: [] });

    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(startButton());

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
      expect(screen.getByTestId("git-init-open")).toBeTruthy();
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
    fireEvent.click(startButton());

    await waitFor(() => {
      expect(screen.getAllByText(/git config --global user\.name/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/finished without a status update/i)).toBeNull();
    expect(retryButton()).toBeTruthy();
  });

  it("surfaces the git config commands and offers Try again on identity error", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText(/initial commit message/i), {
      target: { value: "feat: init" },
    });
    fireEvent.click(startButton());
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
    fireEvent.click(retryButton());

    await waitFor(() => expect(initGitGuidedMock).toHaveBeenCalledTimes(1));
  });

  describe("project identity row", () => {
    function nameInput() {
      return screen.getByLabelText<HTMLInputElement>(/project name/i);
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

      const start = startButton();
      expect(start.disabled).toBe(true);
    });

    it("says why the button went dead instead of only painting the field red", () => {
      renderDialog();
      // Seeded from the folder, so nothing is wrong until the user clears it.
      expect(screen.queryByRole("alert")).toBeNull();

      fireEvent.change(nameInput(), { target: { value: "   " } });

      const message = screen.getByRole("alert");
      expect(nameInput().getAttribute("aria-describedby")).toBe(message.id);
    });

    it("reports the edited identity on success", async () => {
      const onSuccess = vi.fn();
      renderDialog({ onSuccess });

      fireEvent.change(nameInput(), { target: { value: "  Renamed  " } });
      fireEvent.click(startButton());

      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1), { timeout: 3000 });
      // Emoji is seeded from the folder name, and renaming must not re-derive it.
      expect(onSuccess).toHaveBeenCalledWith({
        name: "Renamed",
        emoji: suggestProjectEmoji("new-repo"),
      });
    });

    it("re-seeds when a second request swaps the folder while still open", () => {
      // Deliberately never closes: a request arriving on top of an open dialog
      // swaps directoryPath in place. Seeding only on the open transition would
      // leave folder A's identity attached to folder B's path.
      const props = { onSuccess: vi.fn(), onCancel: vi.fn() };
      const { rerender } = render(
        <GitInitDialog isOpen={true} directoryPath="/tmp/first-folder" {...props} />
      );
      expect(nameInput().value).toBe("first-folder");

      rerender(
        <GitInitDialog
          isOpen={true}
          directoryPath="/tmp/second-folder"
          initialIdentity={{ name: "Second", emoji: "📦" }}
          {...props}
        />
      );

      expect(nameInput().value).toBe("Second");
      expect(screen.getByRole("button", { name: /choose project emoji/i }).textContent).toBe("📦");
    });
  });

  /**
   * The design rules this dialog was rebuilt around, asserted as rules.
   *
   * Every one of these is a defect the surface actually shipped, and each is
   * stated so that the labels, copy and layout can all move without the test
   * needing an edit — only a change that reintroduces the defect fails.
   */
  describe("design invariants", () => {
    /** Hold the IPC promise open so the dialog stays in its running mode. */
    function startAndHang() {
      initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));
      renderDialog();
      fireEvent.click(startButton());
    }

    it("reports a step once — a finished step is stated by its completion, not also by its start", async () => {
      startAndHang();
      await waitFor(() => expect(progressHandler).not.toBeNull());

      act(() => {
        progressHandler?.({
          step: "init",
          status: "start",
          message: "Initializing Git repository...",
          timestamp: Date.now(),
        });
        progressHandler?.({
          step: "init",
          status: "success",
          message: "Git repository initialized",
          timestamp: Date.now(),
        });
        progressHandler?.({
          step: "gitignore",
          status: "start",
          message: "Creating .gitignore file...",
          timestamp: Date.now(),
        });
      });

      await waitFor(
        () => expect(screen.getAllByText(/Git repository initialized/).length).toBe(1),
        {
          timeout: 2000,
        }
      );
      // The start narration for a step that already succeeded must not survive
      // alongside its completion — that is what put four live spinners on a
      // finished run.
      expect(screen.queryByText(/Initializing Git repository/)).toBeNull();
      // ...and the step that IS live is the one the progress readout names.
      // (The label itself deliberately appears twice — once visibly, once in the
      // sr-only live region — so count rows, not text nodes.)
      expect(screen.getByRole("progressbar").getAttribute("aria-label")).toMatch(
        /Creating \.gitignore file/
      );
    });

    it("counts progress against the steps the submitted options imply, not a fixed total", async () => {
      initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));
      renderDialog();
      // Everything off: no gitignore, no commit — one step remains.
      fireEvent.change(screen.getByLabelText(/gitignore template/i), {
        target: { value: "none" },
      });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(startButton());
      await waitFor(() => expect(progressHandler).not.toBeNull());

      act(() => {
        progressHandler?.({
          step: "init",
          status: "start",
          message: "Initializing Git repository...",
          timestamp: Date.now(),
        });
      });

      const bar = await waitFor(() => screen.getByRole("progressbar"), { timeout: 2000 });
      expect(bar.getAttribute("aria-valuemax")).toBe("1");
      expect(bar.getAttribute("aria-valuenow")).toBe("0");
    });

    it("states a failure once, however many error events describe it", async () => {
      renderDialog();
      fireEvent.click(startButton());
      await waitFor(() => expect(progressHandler).not.toBeNull());

      const identityHelp =
        "Set your git identity, then create the initial commit manually:\n" +
        '  git config --global user.name "Your Name"\n' +
        '  git config --global user.email "you@example.com"';

      // The main process reports the failing step AND the terminal outcome, both
      // carrying the same remediation. The surface owes the user one statement.
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

      await waitFor(() => expect(retryButton()).toBeTruthy());
      expect(screen.getAllByText(/user\.name/).length).toBe(1);
      expect(screen.getAllByText(/user\.email/).length).toBe(1);
    });

    it("keeps the recovery commands copyable rather than inert text", async () => {
      renderDialog();
      fireEvent.click(startButton());
      await waitFor(() => expect(progressHandler).not.toBeNull());

      act(() => {
        progressHandler?.({
          step: "commit",
          status: "error",
          message: "Git user identity not configured",
          error:
            "Set your git identity, then create the initial commit manually:\n" +
            '  git config --global user.name "Your Name"\n' +
            '  git config --global user.email "you@example.com"',
          timestamp: Date.now(),
        });
      });

      await waitFor(() => expect(retryButton()).toBeTruthy());
      expect(screen.getAllByRole("button", { name: /copy command to clipboard/i }).length).toBe(2);
    });

    it("does not leave the configuration form standing while the operation runs", async () => {
      startAndHang();
      await waitFor(() => expect(progressHandler).not.toBeNull());

      act(() => {
        progressHandler?.({
          step: "init",
          status: "start",
          message: "Initializing Git repository...",
          timestamp: Date.now(),
        });
      });

      await waitFor(() => expect(screen.getByRole("progressbar")).toBeTruthy(), { timeout: 2000 });
      expect(screen.queryByLabelText(/gitignore template/i)).toBeNull();
      expect(screen.queryByLabelText(/project name/i)).toBeNull();
    });

    it("hands focus to the running readout when the mode destroys the focused control", async () => {
      initGitGuidedMock.mockImplementationOnce(() => new Promise(() => {}));
      renderDialog();
      const start = startButton();
      start.focus();
      expect(document.activeElement).toBe(start);

      fireEvent.click(start);
      await waitFor(() => expect(progressHandler).not.toBeNull());
      act(() => {
        progressHandler?.({
          step: "init",
          status: "start",
          message: "Initializing Git repository...",
          timestamp: Date.now(),
        });
      });

      // The control that had focus is gone. Focus must land inside the new
      // mode rather than falling to <body> — WCAG 2.4.3, failure technique F85.
      await waitFor(
        () => {
          const active = document.activeElement;
          expect(active).not.toBe(document.body);
          expect(screen.getByTestId("git-init-progress").contains(active)).toBe(true);
        },
        { timeout: 2000 }
      );
    });

    it("shows a step count that agrees with the bar it sits beside", async () => {
      startAndHang();
      await waitFor(() => expect(progressHandler).not.toBeNull());

      act(() => {
        for (const [step, message] of [
          ["init", "Initializing Git repository..."],
          ["gitignore", "Creating .gitignore file..."],
        ] as const) {
          progressHandler?.({ step, status: "start", message, timestamp: Date.now() });
          progressHandler?.({
            step,
            status: "success",
            message: `${step} ok`,
            timestamp: Date.now(),
          });
        }
        progressHandler?.({
          step: "add",
          status: "start",
          message: "Staging files for initial commit...",
          timestamp: Date.now(),
        });
      });

      const bar = await waitFor(() => screen.getByRole("progressbar"), { timeout: 2000 });
      const now = Number(bar.getAttribute("aria-valuenow"));
      const max = Number(bar.getAttribute("aria-valuemax"));
      // Whatever the wording, the number the user reads must be the number the
      // bar is drawn from — a counter saying "3 of 4" over a half-filled bar is
      // two answers to one question.
      expect(screen.getByTestId("git-init-progress").textContent).toContain(`${now} of ${max}`);
    });

    it("does not dress the forward action up as a dismissal once it has succeeded", async () => {
      const onSuccess = vi.fn();
      const onCancel = vi.fn();
      renderDialog({ onSuccess, onCancel });
      fireEvent.click(startButton());

      await waitFor(() => expect(screen.getByTestId("git-init-success")).toBeTruthy());
      // Escape, the backdrop and the header X all route to the same handler,
      // and in this mode that handler OPENS the project. So the dialog must not
      // offer them: the mode has one action and it is labelled.
      expect(screen.getByTestId("app-dialog").getAttribute("data-dismissible")).toBe("false");
      expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("explains every field that can dead the primary action", () => {
      renderDialog();
      const start = startButton();
      const inputs = [
        screen.getByLabelText<HTMLInputElement>(/project name/i),
        screen.getByLabelText<HTMLInputElement>(/initial commit message/i),
      ];

      for (const input of inputs) {
        const original = input.value;
        fireEvent.change(input, { target: { value: "   " } });
        expect(start.disabled).toBe(true);
        // Emptying it must produce an explanation, and that explanation must be
        // wired to the field it is about — not merely painted on the border.
        const describedBy = input.getAttribute("aria-describedby");
        expect(describedBy).toBeTruthy();
        const message = document.getElementById(describedBy as string);
        expect(message?.getAttribute("role")).toBe("alert");
        expect(message?.textContent?.trim().length).toBeGreaterThan(0);
        fireEvent.change(input, { target: { value: original } });
      }
    });
  });
});
