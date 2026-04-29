/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { CloneRepoProgressEvent } from "@shared/types/ipc/gitClone";

const { cloneRepoMock, onCloneProgressMock, openDialogMock, cancelCloneMock } = vi.hoisted(() => ({
  cloneRepoMock: vi.fn(),
  onCloneProgressMock: vi.fn(),
  openDialogMock: vi.fn(),
  cancelCloneMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    cloneRepo: cloneRepoMock,
    onCloneProgress: onCloneProgressMock,
    openDialog: openDialogMock,
    cancelClone: cancelCloneMock,
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

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("/tmp/my-repo"));
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

  it("Cancel button calls cancelClone during active clone", async () => {
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

    const cancelBtn = screen.getByText("Cancel");
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(cancelBtn);
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
});
