/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { CloneRepoProgressEvent } from "@shared/types/ipc/gitClone";

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

const { cloneRepoMock, onCloneProgressMock, openDialogMock, cancelCloneMock, dispatchMock } =
  vi.hoisted(() => ({
    cloneRepoMock: vi.fn(),
    onCloneProgressMock: vi.fn(),
    openDialogMock: vi.fn(),
    cancelCloneMock: vi.fn(),
    dispatchMock: vi.fn(),
  }));

vi.mock("@/clients", () => ({
  projectClient: {
    cloneRepo: cloneRepoMock,
    onCloneProgress: onCloneProgressMock,
    openDialog: openDialogMock,
    cancelClone: cancelCloneMock,
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
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
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
    className?: string;
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
  AppDialog.Body = ({ children, className: _ }: AppDialogSectionProps) => <div>{children}</div>;

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
    actions,
    onClose,
  }: {
    title: ReactNode;
    description?: ReactNode;
    actions?: MockBannerAction[];
    onClose?: () => void;
  }) => (
    <div data-testid="cleanup-banner">
      <span>{title}</span>
      <span>{description}</span>
      {actions?.map((action) => (
        <button
          key={action.id}
          type="button"
          aria-label={action.ariaLabel}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
      {onClose && (
        <button type="button" onClick={onClose}>
          banner-dismiss
        </button>
      )}
    </div>
  ),
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

  it("renders input fields when opened", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    expect(
      screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git")
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("Select a directory...")).toBeTruthy();
    expect(screen.getByText("Clone")).toBeTruthy();
  });

  it("Clone button is disabled when URL or path is empty", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const cloneBtn = screen.getByText("Clone") as HTMLButtonElement;
    expect(cloneBtn.disabled).toBe(true);
  });

  it("auto-derives folder name from URL", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/my-repo.git" } });

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const folderInput = inputs.find((i) => i.value === "my-repo");
    expect(folderInput).toBeDefined();
  });

  it("calls cloneRepo with correct options on submit", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    act(() => {
      progressHandler?.({
        stage: "receiving",
        progress: 50,
        message: "receiving: 50%",
        timestamp: Date.now(),
      });
    });

    expect(screen.getByText("receiving: 50%")).toBeTruthy();
  });

  it("calls onSuccess with clonedPath after successful clone", async () => {
    const onSuccess = vi.fn();

    render(<CloneRepoDialog isOpen={true} onSuccess={onSuccess} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
      expect(screen.getByText("Open Project")).toBeTruthy();
    });

    // Auto-close runs after AUTO_CLOSE_DELAY_MS (2s) — extend the waitFor
    // timeout so the assertion outlives the dialog's read-the-log delay.
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("/tmp/my-repo"), {
      timeout: 3000,
    });
  });

  it("shows error and retry button on clone failure", async () => {
    cloneRepoMock.mockRejectedValue(
      Object.assign(new Error("Auth failed"), { name: "AppError", code: "INTERNAL" })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
      expect(screen.getByText("Clone Failed")).toBeTruthy();
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
      expect(screen.getByText("Sign in with GitHub")).toBeTruthy();
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    const signInBtn = await waitFor(() => screen.getByText("Sign in with GitHub"));
    expect(signInBtn).toBeTruthy();
    expect(screen.getByText("Clone Failed")).toBeTruthy();

    await act(async () => {
      fireEvent.click(signInBtn);
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "github" },
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
      expect(screen.getByText("Sign in with GitHub")).toBeTruthy();
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
      expect(screen.getByText("Clone Failed")).toBeTruthy();
    });
    expect(screen.queryByText("Sign in with GitHub")).toBeNull();
  });

  it("does not show GitHub CTA when failure reason is not auth-failed", async () => {
    cloneRepoMock.mockRejectedValue(
      Object.assign(new Error("Could not resolve host: github.com"), {
        name: "GitOperationError",
        gitReason: "network-unavailable",
      })
    );

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
      expect(screen.getByText("Clone Failed")).toBeTruthy();
    });
    expect(screen.queryByText("Sign in with GitHub")).toBeNull();
  });

  it("is not dismissible while cloning", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

  it("auto-derives folder name from owner/repo shorthand", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
    fireEvent.change(urlInput, { target: { value: "facebook/react" } });

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const folderInput = inputs.find((i) => i.value === "react");
    expect(folderInput).toBeDefined();
  });

  it("sends shallowClone: true when checkbox is checked", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
      expect(screen.queryByText("Clone Failed")).toBeNull();
    });
  });

  it("preserves Unicode characters in derived folder name", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
    fireEvent.change(urlInput, { target: { value: "https://github.com/foo/café.git" } });

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const folderInput = inputs.find((i) => i.value === "café");
    expect(folderInput).toBeDefined();
  });

  it("re-enables auto-derive when manually-edited folder name is cleared", () => {
    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    // counting and checkout (one each) survive; receiving collapses to its
    // latest value. A broken implementation that simply replaced the entire
    // list with each new event would lose counting/checkout.
    expect(screen.getByText("counting: 100%")).toBeTruthy();
    expect(screen.getByText("checkout: 0%")).toBeTruthy();
    expect(screen.queryByText("receiving: 10%")).toBeNull();
    expect(screen.getByText("receiving: 80%")).toBeTruthy();
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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
    fireEvent.change(urlInput, { target: { value: "https://github.com/user/repo.git" } });

    const browseBtn = screen.getByText("Browse");
    await act(async () => {
      fireEvent.click(browseBtn);
    });

    const cloneBtn = screen.getByText("Clone");
    await act(async () => {
      fireEvent.click(cloneBtn);
    });

    await waitFor(() => expect(screen.getByText("Clone Failed")).toBeTruthy());

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

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    // The cancelled message is visible alongside its specific (non-spinner)
    // icon — confirms it doesn't fall through to the in-progress Spinner.
    const cancelledRow = screen.getByText("Clone cancelled").closest("div");
    expect(cancelledRow).toBeTruthy();
    expect(cancelledRow!.querySelector('[data-testid="spinner"]')).toBeNull();
  });

  it("dedups progress events by stage so a single stage shows one row", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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

    // Only the latest message for the `receiving` stage should remain — the
    // earlier 10–90% rows are deduped out, leaving a single live row.
    expect(screen.queryByText("receiving: 0%")).toBeNull();
    expect(screen.queryByText("receiving: 50%")).toBeNull();
    expect(screen.getByText("receiving: 100%")).toBeTruthy();
  });

  it("does not treat full URLs as owner/repo shorthand", async () => {
    cloneRepoMock.mockImplementation(() => new Promise(() => {}));

    render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
    const urlInput = screen.getByPlaceholderText("owner/repo or https://github.com/user/repo.git");
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
      expect(screen.getByText("Receiving: 5%")).toBeTruthy();
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
      expect(screen.getByText("Receiving: 12%")).toBeTruthy();
    });
  });

  describe("cleanup-failure banner", () => {
    it("renders the cleanup-failed event as a separate banner, not a log row", async () => {
      cloneRepoMock.mockImplementation(() => new Promise(() => {}));
      render(<CloneRepoDialog isOpen={true} onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await startActiveClone();

      await waitFor(() => expect(progressHandler).not.toBeNull());

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
      expect(banner.textContent).toContain("Couldn't remove the partial clone at /tmp/repo.");
      // The cleanup message must appear exactly once — only in the banner,
      // never also as a deduped row in the progress log.
      expect(screen.getAllByText("Couldn't remove the partial clone at /tmp/repo.")).toHaveLength(
        1
      );
      // The real progress row is still there, unaffected.
      expect(screen.getByText("Receiving: 40%")).toBeTruthy();
    });

    it("dismisses the cleanup banner via its close control", async () => {
      cloneRepoMock.mockImplementation(() => new Promise(() => {}));
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

      expect(screen.getByTestId("cleanup-banner")).toBeTruthy();

      await act(async () => {
        fireEvent.click(screen.getByText("banner-dismiss"));
      });

      expect(screen.queryByTestId("cleanup-banner")).toBeNull();
    });
  });
});
