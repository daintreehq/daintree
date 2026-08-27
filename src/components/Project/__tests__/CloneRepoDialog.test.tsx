/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { CloneRepoProgressEvent } from "@shared/types/ipc/gitClone";
import { suggestProjectEmoji } from "@shared/utils/projectEmoji";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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

const {
  cloneRepoMock,
  onCloneProgressMock,
  openDialogMock,
  cancelCloneMock,
  dispatchMock,
  showItemInFolderMock,
} = vi.hoisted(() => ({
  cloneRepoMock: vi.fn(),
  onCloneProgressMock: vi.fn(),
  openDialogMock: vi.fn(),
  cancelCloneMock: vi.fn(),
  dispatchMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    cloneRepo: cloneRepoMock,
    onCloneProgress: onCloneProgressMock,
    openDialog: openDialogMock,
    cancelClone: cancelCloneMock,
  },
  systemClient: {
    showItemInFolderUnconfined: showItemInFolderMock,
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    loading,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
    loading?: boolean;
  }) => (
    <button type="button" aria-busy={loading || undefined} {...props}>
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
    className?: string;
  }

  // The synthetic close button stands in for Escape and the backdrop, both of
  // which the real AppDialog withholds when `dismissible` is false. Rendering it
  // unconditionally made the mock unable to express the one thing the completed
  // mode changed.
  const AppDialog = ({ isOpen, children, onClose, dismissible = true }: AppDialogMockProps) =>
    isOpen ? (
      <div data-testid="app-dialog" data-dismissible={dismissible ? "true" : "false"}>
        {dismissible && (
          <button type="button" onClick={onClose}>
            dialog-close
          </button>
        )}
        {children}
      </div>
    ) : null;

  AppDialog.Header = ({ children }: AppDialogSectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: AppDialogSectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.Body = ({ children, className: _ }: AppDialogSectionProps) => <div>{children}</div>;
  AppDialog.Footer = ({ children, className: _ }: AppDialogSectionProps) => <div>{children}</div>;

  return { AppDialog };
});

vi.mock("@/components/ui/Spinner", () => ({
  Spinner: () => <span data-testid="spinner">loading</span>,
}));

interface MockBannerAction {
  id: string;
  label: string;
  onClick?: () => void;
  ariaLabel?: string;
}

vi.mock("@/components/Terminal/InlineStatusBanner", () => ({
  InlineStatusBanner: ({
    title,
    description,
    contextLine,
    action,
    actions,
    onClose,
  }: {
    title: ReactNode;
    description?: ReactNode;
    contextLine?: string;
    action?: MockBannerAction;
    actions?: MockBannerAction[];
    onClose?: () => void;
  }) => {
    const actionList = actions ?? (action ? [action] : []);
    return (
      <div data-testid="cleanup-banner">
        <span>{title}</span>
        <span>{description}</span>
        {contextLine !== undefined && <span data-testid="banner-context">{contextLine}</span>}
        {actionList.map((a) => (
          <button key={a.id} type="button" aria-label={a.ariaLabel} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
        {onClose && (
          <button type="button" onClick={onClose}>
            banner-dismiss
          </button>
        )}
      </div>
    );
  },
}));

import { CloneRepoDialog } from "../CloneRepoDialog";

describe("CloneRepoDialog", () => {
  let progressHandler: ((event: CloneRepoProgressEvent) => void) | null = null;
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    vi.clearAllMocks();
    progressHandler = null;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    // The dialog loads registered forge provider matchers on open to gate the
    // auth-failed recovery banner.
    (globalThis as { window?: { electron?: unknown } }).window!.electron = {
      forge: {
        getProviders: vi.fn().mockResolvedValue([
          {
            pluginId: "daintree.github",
            contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
          },
        ]),
      },
    } as unknown as typeof window.electron;

    onCloneProgressMock.mockImplementation((callback: (event: CloneRepoProgressEvent) => void) => {
      progressHandler = callback;
      return vi.fn();
    });

    cloneRepoMock.mockResolvedValue({ clonedPath: "/tmp/my-repo" });
    openDialogMock.mockResolvedValue("/tmp");
  });

  afterEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  });

  /**
   * The mode swap is gated on the Doherty threshold, so the running view does
   * not exist for the first 400ms of a clone however fast the first progress
   * event arrives. Tests that assert on the live phase have to cross it first.
   */
  async function waitForRunningMode() {
    await screen.findByText("Connecting…", {}, { timeout: 3000 });
  }

  /**
   * The live phase is gated behind a real 400ms timer AND arrives through an
   * IPC callback, so querying for it synchronously races the gate — which
   * passed in isolation and flaked under full-suite load.
   */
  async function findProgressBar(): Promise<HTMLElement> {
    return screen.findByRole("progressbar", {}, { timeout: 3000 });
  }

  it("renders input fields when opened", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText(/repository url/i)).toBeTruthy();
    expect(screen.getByLabelText(/parent directory/i)).toBeTruthy();
    expect(screen.getByLabelText(/folder name/i)).toBeTruthy();
    expect(screen.getByText("Clone")).toBeTruthy();
  });

  it("Clone button is disabled when URL or path is empty", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const cloneBtn = screen.getByText("Clone") as HTMLButtonElement;
    expect(cloneBtn.disabled).toBe(true);
  });

  it("auto-derives folder name from URL", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/my-repo.git" } });

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const folderInput = inputs.find((i) => i.value === "my-repo");
    expect(folderInput).toBeDefined();
  });

  it("calls cloneRepo with correct options on submit", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/test-repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    expect(cloneRepoMock).toHaveBeenCalledWith({
      url: "https://github.com/user/test-repo.git",
      parentPath: "/tmp",
      folderName: "test-repo",
      shallowClone: false,
    });
  });

  it("shows progress events during clone", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(progressHandler).not.toBeNull());
    await waitForRunningMode();

    act(() => {
      progressHandler?.({
        stage: "receiving",
        progress: 50,
        message: "receiving: 50%",
        timestamp: Date.now(),
      });
    });

    expect((await findProgressBar()).getAttribute("aria-label")).toBe("receiving");
  });

  it("stops offering a dismissal once the only thing it can do is open the project", async () => {
    const onCancel = vi.fn();
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={onCancel} />);

    fireEvent.change(screen.getByPlaceholderText("owner/repo or repository URL"), {
      target: { value: "https://github.com/user/my-repo.git" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Browse"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Clone"));
    });

    await waitFor(() => expect(screen.getByText("Open project")).toBeTruthy());
    // Escape, the backdrop and the header X all route to the same handler, and
    // in this mode that handler OPENS the project. A control that presents as a
    // dismissal must not be the forward action wearing a disguise.
    expect(screen.getByTestId("app-dialog").getAttribute("data-dismissible")).toBe("false");
    expect(screen.queryByText("dialog-close")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onSuccess with clonedPath after successful clone", async () => {
    const onSuccess = vi.fn();

    render(<CloneRepoDialog isOpen={true} onSuccess={onSuccess} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/my-repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Open project")).toBeTruthy();
    });

    // Auto-close runs after AUTO_CLOSE_DELAY_MS (2s) — extend the waitFor
    // timeout so the assertion outlives the dialog's read-the-log delay.
    await waitFor(
      () =>
        expect(onSuccess).toHaveBeenCalledWith("/tmp/my-repo", {
          name: "my-repo",
          emoji: suggestProjectEmoji("my-repo"),
        }),
      {
        timeout: 3000,
      }
    );
  });

  it("shows error and retry button on clone failure", async () => {
    cloneRepoMock.mockRejectedValue(
      Object.assign(new Error("Auth failed"), { name: "AppError", code: "INTERNAL" })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Clone failed")).toBeTruthy();
      expect(screen.getByText("Auth failed")).toBeTruthy();
      expect(screen.getByText("Retry")).toBeTruthy();
    });
  });

  it("shows GitHub sign-in CTA even after an 'error' progress event is emitted", async () => {
    // Reproduces the production flow: the handler calls emitProgress("error",
    // ...) before throwing, so the renderer's progressEvents list contains
    // {stage:"error"} by the time setError runs. The banner must still render.
    let rejectClone: (err: unknown) => void = () => {};
    cloneRepoMock.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectClone = reject;
        })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, {
      target: { value: "https://github.com/acme/private.git" },
    });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(progressHandler).not.toBeNull());

    // Emit the error progress event first (matches handler ordering), then
    // reject the invoke — the banner must still appear.
    act(() => {
      progressHandler?.({
        stage: "error",
        progress: 0,
        message: "Clone failed: Authentication failed",
        timestamp: Date.now(),
      });
    });

    await act(async () => {
      rejectClone(
        Object.assign(new Error("Authentication failed"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in to GitHub")).toBeTruthy();
    });
  });

  it("shows GitHub sign-in CTA when auth fails against a github.com URL", async () => {
    cloneRepoMock.mockRejectedValue(
      Object.assign(new Error("Authentication failed for 'https://github.com/acme/private.git/'"), {
        name: "GitOperationError",
        gitReason: "auth-failed",
      })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, {
      target: { value: "https://github.com/acme/private.git" },
    });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    const signInBtn = await waitFor(() => screen.getByText("Sign in to GitHub"));
    expect(signInBtn).toBeTruthy();
    expect(screen.getByText("Clone failed")).toBeTruthy();

    await act(async () => {
      fireEvent.click(signInBtn);
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "daintree.github.github" },
      { source: "user" }
    );
  });

  it("shows GitHub sign-in CTA when auth fails on owner/repo shorthand", async () => {
    cloneRepoMock.mockRejectedValue(
      Object.assign(new Error("Authentication failed"), {
        name: "GitOperationError",
        gitReason: "auth-failed",
      })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "acme/private" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Sign in to GitHub")).toBeTruthy();
    });
  });

  it("does not show GitHub CTA when auth fails on a non-GitHub URL", async () => {
    cloneRepoMock.mockRejectedValue(
      Object.assign(new Error("Authentication failed"), {
        name: "GitOperationError",
        gitReason: "auth-failed",
      })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, {
      target: { value: "https://gitlab.com/acme/private.git" },
    });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Clone failed")).toBeTruthy();
    });
    expect(screen.queryByText("Sign in to GitHub")).toBeNull();
  });

  it("does not show GitHub CTA when failure reason is not auth-failed", async () => {
    cloneRepoMock.mockRejectedValue(
      Object.assign(new Error("Could not resolve host: github.com"), {
        name: "GitOperationError",
        gitReason: "network-unavailable",
      })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, {
      target: { value: "https://github.com/acme/private.git" },
    });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Clone failed")).toBeTruthy();
    });
    expect(screen.queryByText("Sign in to GitHub")).toBeNull();
  });

  it("is not dismissible while cloning", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    const dialog = screen.getByTestId("app-dialog");
    expect(dialog.getAttribute("data-dismissible")).toBe("false");
  });

  it("does not render when isOpen is false", () => {
    render(<CloneRepoDialog isOpen={false} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByTestId("app-dialog")).toBeNull();
  });

  it("expands owner/repo shorthand to full GitHub URL on clone", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "vercel/next.js" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    expect(cloneRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://github.com/vercel/next.js",
        folderName: "next.js",
      })
    );
  });

  it("does not expand owner/repo shorthand when multiple providers are registered", async () => {
    (globalThis as { window?: { electron?: unknown } }).window!.electron = {
      forge: {
        getProviders: vi.fn().mockResolvedValue([
          {
            pluginId: "daintree.github",
            contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
          },
          {
            pluginId: "acme.gitlab",
            contribution: { id: "gitlab", name: "GitLab", matches: ["gitlab.com"] },
          },
        ]),
      },
    } as unknown as typeof window.electron;
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "vercel/next.js" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    // Shorthand has no well-defined host with two providers — the URL stays
    // unexpanded and fails validation, so Clone is disabled.
    const cloneBtn = screen.getByText("Clone") as HTMLButtonElement;
    expect(cloneBtn.disabled).toBe(true);
    expect(cloneRepoMock).not.toHaveBeenCalled();
  });

  it("auto-derives folder name from owner/repo shorthand", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "facebook/react" } });

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const folderInput = inputs.find((i) => i.value === "react");
    expect(folderInput).toBeDefined();
  });

  it("sends shallowClone: true when checkbox is checked", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    expect(cloneRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shallowClone: true,
      })
    );
  });

  it("Stop clone button calls cancelClone during active clone", async () => {
    cancelCloneMock.mockResolvedValue(undefined);
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    // While cloning, the secondary button label switches from "Cancel" (close
    // dialog) to "Stop clone" (abort in-flight work) to disambiguate intent.
    expect(screen.queryByText("Cancel")).toBeNull();
    const stopBtn = screen.getByText("Stop clone");
    expect((stopBtn as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(stopBtn);
    });

    expect(cancelCloneMock).toHaveBeenCalled();
  });

  it("does not show error after cancelled clone", async () => {
    cloneRepoMock.mockRejectedValue(
      Object.assign(new Error("Clone cancelled"), { name: "AppError", code: "CANCELLED" })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => {
      expect(screen.queryByText("Clone failed")).toBeNull();
    });
  });

  it("treats a bridge-shaped CANCELLED rejection as a stop, not a failure", async () => {
    // The shape that actually reaches the renderer. `contextBridge` strips own
    // Error properties, so the preload encodes the code into the message and
    // `code` is undefined by the time the dialog sees it. Reading `err.code`
    // here used to classify every user stop as a failure and print the raw
    // `[AppError|CANCELLED]` prefix into the error surface.
    // Resolve only once a stage has been emitted, so the stop happens with a
    // live phase on screen — the case the unit suite previously never hit.
    let rejectClone: ((reason: Error) => void) | null = null;
    cloneRepoMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectClone = reject;
        })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(progressHandler).not.toBeNull());
    await waitForRunningMode();
    act(() => {
      progressHandler?.({
        stage: "receiving",
        progress: 42,
        message: "receiving: 42%",
        timestamp: Date.now(),
      });
    });
    expect(await findProgressBar()).toBeTruthy();

    await act(async () => {
      rejectClone?.(new Error("[AppError|CANCELLED] Clone cancelled"));
    });

    await waitFor(() => {
      expect(screen.getByText("Clone stopped")).toBeTruthy();
    });
    expect(screen.queryByText("Clone failed")).toBeNull();
    // No internal encoding may reach the user, in any surface.
    expect(document.body.textContent).not.toContain("[AppError");
    // A stop leaves the form editable so Clone can simply be pressed again.
    expect(screen.getByRole("button", { name: "Clone" }).hasAttribute("disabled")).toBe(false);
    // And the live phase is gone. A leftover stage would keep the running mode
    // on screen, so the dialog would still look like it were cloning.
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryAllByTestId("spinner")).toHaveLength(0);
  });

  it("states a failure once, never as both a stage row and a banner", async () => {
    const gitError = Object.assign(new Error("early EOF"), {
      name: "GitOperationError",
      gitReason: "unknown",
    });
    cloneRepoMock.mockRejectedValue(gitError);

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(progressHandler).not.toBeNull());

    // The handler emits an `error` progress event before it throws. Rendering
    // that as a stage as well is what put the same sentence on screen twice.
    act(() => {
      progressHandler?.({
        stage: "error",
        progress: 0,
        message: "Clone failed: early EOF",
        timestamp: Date.now(),
      });
    });

    await waitFor(() => expect(screen.getByText("Clone failed")).toBeTruthy());
    expect(screen.getAllByText("early EOF")).toHaveLength(1);
    expect(screen.queryByText("Clone failed: early EOF")).toBeNull();
  });

  it("preserves Unicode characters in derived folder name", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/foo/café.git" } });

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const folderInput = inputs.find((i) => i.value === "café");
    expect(folderInput).toBeDefined();
  });

  it("re-enables auto-derive when manually-edited folder name is cleared", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/first.git" } });

    let inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    let folderInput = inputs.find((i) => i.value === "first");
    expect(folderInput).toBeDefined();

    // Manually edit, then clear — clear should re-enable auto-derive.
    fireEvent.change(folderInput!, { target: { value: "manual-name" } });
    fireEvent.change(folderInput!, { target: { value: "" } });

    // Now changing the URL should refill the folder name.
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/second.git" } });

    inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    folderInput = inputs.find((i) => i.value === "second");
    expect(folderInput).toBeDefined();
  });

  it("submits clone when Enter is pressed in URL input", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    await act(async () => {
      fireEvent.keyDown(urlInput, { key: "Enter" });
    });

    expect(cloneRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://github.com/user/repo.git" })
    );
  });

  it("does not submit on Enter when form is invalid", async () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    // No parent path picked yet — canClone is false.
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    await act(async () => {
      fireEvent.keyDown(urlInput, { key: "Enter" });
    });

    expect(cloneRepoMock).not.toHaveBeenCalled();
  });

  it("dedup keeps distinct stages while collapsing repeats within a stage", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(progressHandler).not.toBeNull());
    await waitForRunningMode();

    act(() => {
      progressHandler?.({
        stage: "counting",
        progress: 100,
        message: "counting: 100%",
        timestamp: Date.now(),
      });
      progressHandler?.({
        stage: "receiving",
        progress: 10,
        message: "receiving: 10%",
        timestamp: Date.now(),
      });
      progressHandler?.({
        stage: "checkout",
        progress: 0,
        message: "checkout: 0%",
        timestamp: Date.now(),
      });
      progressHandler?.({
        stage: "receiving",
        progress: 80,
        message: "receiving: 80%",
        timestamp: Date.now(),
      });
    });

    // The invariant: however many stages have been seen, exactly one is live.
    // Multiple concurrent spinners were the defect — finished git stages never
    // emit a terminal event, so every row used to keep spinning forever.
    expect(screen.getAllByTestId("spinner")).toHaveLength(1);

    // Earlier stages are still accounted for, quieted rather than dropped:
    // they are what makes the live stage's bar restarting at 0% legible.
    // `receiving` appears twice on purpose — the visible label plus the
    // sr-only status node that announces phase changes.
    expect(screen.getByText("counting")).toBeTruthy();
    expect(screen.getAllByText("receiving").length).toBeGreaterThan(0);

    // The live stage is the most recent event's stage, and its percentage is
    // read off the payload rather than scraped out of the message string.
    expect((await findProgressBar()).getAttribute("aria-valuenow")).toBe("80");
    expect((await findProgressBar()).getAttribute("aria-label")).toBe("receiving");
  });

  it("Enter retries after a failed clone (matches Retry button behavior)", async () => {
    // First call rejects, second resolves — simulates the user pressing Enter
    // again after seeing an error.
    cloneRepoMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Auth failed"), { name: "AppError", code: "INTERNAL" })
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(screen.getByText("Clone failed")).toBeTruthy());

    // Press Enter — should fire a second clone attempt without requiring the
    // user to click Retry, since the form fields are still valid.
    await act(async () => {
      fireEvent.keyDown(urlInput, { key: "Enter" });
    });

    expect(cloneRepoMock).toHaveBeenCalledTimes(2);
  });

  it("renders cancelled stage with non-spinning icon", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(progressHandler).not.toBeNull());
    await waitForRunningMode();

    act(() => {
      progressHandler?.({
        stage: "receiving",
        progress: 50,
        message: "receiving: 50%",
        timestamp: Date.now(),
      });
      progressHandler?.({
        stage: "cancelled",
        progress: 0,
        message: "Clone cancelled",
        timestamp: Date.now(),
      });
    });

    // A terminal `cancelled` event is reported by the promise, not rendered as
    // a stage, so it must never become a row of its own — and it must not
    // displace the live stage either.
    expect(screen.queryByText("Clone cancelled")).toBeNull();
    expect((await findProgressBar()).getAttribute("aria-label")).toBe("receiving");
    expect(screen.getAllByTestId("spinner")).toHaveLength(1);
  });

  it("dedups progress events by stage so a single stage shows one row", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(progressHandler).not.toBeNull());
    await waitForRunningMode();

    act(() => {
      for (let pct = 0; pct <= 100; pct += 10) {
        progressHandler?.({
          stage: "receiving",
          progress: pct,
          message: `receiving: ${pct}%`,
          timestamp: Date.now(),
        });
      }
    });

    // One stage updating repeatedly stays one row — an unbounded log was the
    // old failure mode — and the reported value tracks the latest payload.
    expect(screen.getAllByTestId("spinner")).toHaveLength(1);
    expect((await findProgressBar()).getAttribute("aria-valuenow")).toBe("100");
  });

  it("reads the percentage from the payload, not from the message text", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(progressHandler).not.toBeNull());
    await waitForRunningMode();

    // Message and payload deliberately disagree. The bar must follow `progress`.
    act(() => {
      progressHandler?.({
        stage: "receiving",
        progress: 37,
        message: "receiving: 99%",
        timestamp: Date.now(),
      });
    });

    expect((await findProgressBar()).getAttribute("aria-valuenow")).toBe("37");
  });

  it("does not treat full URLs as owner/repo shorthand", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://gitlab.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    expect(cloneRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://gitlab.com/user/repo.git",
      })
    );
  });

  async function startActiveClone() {
    const urlInput = screen.getByPlaceholderText("owner/repo or repository URL");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });
    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });
    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });
  }

  describe("Doherty-gated connecting placeholder", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      cloneRepoMock.mockImplementation(() => new Promise(() => {}));
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it("does not flash a spinner or box before the 400ms threshold", async () => {
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      act(() => {
        vi.advanceTimersByTime(399);
      });

      expect(screen.queryByText("Connecting…")).toBeNull();
      expect(screen.queryByTestId("spinner")).toBeNull();
    });

    it("shows the connecting placeholder once the threshold elapses", async () => {
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      act(() => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.getByText("Connecting…")).toBeTruthy();
    });

    it("never flashes the placeholder when progress arrives before the threshold", async () => {
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      act(() => {
        vi.advanceTimersByTime(200);
        progressHandler?.({
          stage: "receiving",
          progress: 5,
          message: "Receiving: 5%",
          timestamp: Date.now(),
        });
      });

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.queryByText("Connecting…")).toBeNull();
      expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe("Receiving");
    });

    it("does not switch to the running view when progress arrives before the threshold", async () => {
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      act(() => {
        vi.advanceTimersByTime(200);
        progressHandler?.({
          stage: "receiving",
          progress: 5,
          message: "Receiving: 5%",
          timestamp: Date.now(),
        });
      });

      // A clone fast enough to report progress inside the threshold must not
      // flash the monitor. Gating on "no event yet" rather than on the clone
      // itself let a quick first event bypass the gate entirely.
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(screen.queryByTestId("spinner")).toBeNull();
      // Still the configuration form, untouched.
      expect(screen.getByPlaceholderText("owner/repo or repository URL")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("5");
    });

    it("replaces the placeholder with the live log when the first event arrives", async () => {
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByText("Connecting…")).toBeTruthy();

      act(() => {
        progressHandler?.({
          stage: "receiving",
          progress: 12,
          message: "Receiving: 12%",
          timestamp: Date.now(),
        });
      });

      expect(screen.queryByText("Connecting…")).toBeNull();
      expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe("Receiving");
    });
  });

  it("keeps the running mode's live regions out of any aria-busy subtree", async () => {
    // An `aria-busy="true"` ancestor silences mutations within its subtree on
    // modern screen readers (the hazard `SkeletonHint` documents), so nesting
    // the phase announcer or the "Still working…" hint under one would mute
    // exactly the updates this mode exists to speak.
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await startActiveClone();

    await waitFor(() => expect(progressHandler).not.toBeNull());
    await waitForRunningMode();

    // The phase announcer plus SkeletonHint's always-present live region.
    const liveRegions = Array.from(document.querySelectorAll("[aria-live]"));
    expect(liveRegions.length).toBeGreaterThanOrEqual(2);
    for (const region of liveRegions) {
      expect(region.closest('[aria-busy="true"]')).toBeNull();
    }
  });

  describe("cleanup-failure banner", () => {
    it("renders the cleanup-failed event as a separate banner, not a log row", async () => {
      cloneRepoMock.mockImplementation(() => new Promise(() => {}));
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      await waitFor(() => expect(progressHandler).not.toBeNull());
      await waitForRunningMode();

      act(() => {
        progressHandler?.({
          stage: "receiving",
          progress: 40,
          message: "Receiving: 40%",
          timestamp: Date.now(),
        });
        progressHandler?.({
          stage: "cleanup-failed",
          progress: 0,
          message: "Couldn't remove the partial clone at /tmp/repo.",
          timestamp: Date.now(),
        });
      });

      const banner = screen.getByTestId("cleanup-banner");
      expect(banner).toBeTruthy();
      expect(banner.textContent).toContain("Partial clone not removed");
      // The stranded path is carried as the banner's context line rather than
      // buried in prose, and it names the composed destination.
      expect(screen.getByTestId("banner-context").textContent).toBe("/tmp/repo");
      // Exactly one cleanup surface — never also a row in the progress region.
      expect(screen.getAllByTestId("cleanup-banner")).toHaveLength(1);
      // The live stage is unaffected: cleanup failure is orthogonal to it.
      expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe("Receiving");
    });

    it("keeps the failed run's path after the returned form is edited", async () => {
      // A failure hands the form back editable with the banner still up. The
      // stranded folder is wherever the clone that failed was pointed, so
      // retyping the folder name must not repoint the banner — or its reveal
      // action — at a directory nothing was ever cloned into.
      let rejectClone: ((reason: Error) => void) | null = null;
      cloneRepoMock.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectClone = reject;
          })
      );
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      await waitFor(() => expect(progressHandler).not.toBeNull());

      act(() => {
        progressHandler?.({
          stage: "cleanup-failed",
          progress: 0,
          message: "Couldn't remove the partial clone at /tmp/repo.",
          timestamp: Date.now(),
        });
      });

      await act(async () => {
        rejectClone?.(new Error("Failed to clone repository"));
      });

      await waitFor(() => expect(screen.getByText("Clone failed")).toBeTruthy());

      fireEvent.change(screen.getByLabelText(/folder name/i), {
        target: { value: "somewhere-else" },
      });

      expect(screen.getByTestId("banner-context").textContent).toBe("/tmp/repo");

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Show the partial clone in the file manager"));
      });
      expect(showItemInFolderMock).toHaveBeenCalledWith("/tmp/repo");
    });

    it("dismisses the cleanup banner via its close control", async () => {
      cloneRepoMock.mockImplementation(() => new Promise(() => {}));
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      await waitFor(() => expect(progressHandler).not.toBeNull());
      await waitForRunningMode();

      act(() => {
        progressHandler?.({
          stage: "cleanup-failed",
          progress: 0,
          message: "Couldn't remove the partial clone at /tmp/repo.",
          timestamp: Date.now(),
        });
      });

      expect(screen.getByTestId("cleanup-banner")).toBeTruthy();

      await act(async () => {
        fireEvent.click(screen.getByText("banner-dismiss"));
      });

      expect(screen.queryByTestId("cleanup-banner")).toBeNull();
    });
  });
});
