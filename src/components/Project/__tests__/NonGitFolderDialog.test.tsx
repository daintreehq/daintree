/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";

const gitInitDialogSpy = vi.hoisted(() => vi.fn());

vi.mock("../GitInitDialog", () => ({
  GitInitDialog: (props: { directoryPath: string }) => {
    gitInitDialogSpy(props);
    return <div data-testid="git-init-dialog" />;
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
  }
  interface SectionProps {
    children: ReactNode;
  }

  const AppDialog = ({ isOpen, children, onClose }: AppDialogMockProps) =>
    isOpen ? (
      <div data-testid="app-dialog">
        <button type="button" onClick={onClose}>
          dialog-close
        </button>
        {children}
      </div>
    ) : null;

  AppDialog.Header = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: SectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.Body = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Footer = ({ children }: SectionProps) => <div>{children}</div>;

  return { AppDialog };
});

import { NonGitFolderDialog } from "../NonGitFolderDialog";

const DIRECTORY = "/Users/someone/Downloads/archive";

function renderDialog(overrides: Partial<Parameters<typeof NonGitFolderDialog>[0]> = {}) {
  const props = {
    isOpen: true,
    directoryPath: DIRECTORY,
    initialStep: "choice" as const,
    onOpenWithoutGit: vi.fn(),
    onInitSuccess: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<NonGitFolderDialog {...props} />) };
}

describe("NonGitFolderDialog (#11405)", () => {
  beforeEach(() => {
    gitInitDialogSpy.mockClear();
  });

  it("names the folder being opened", () => {
    renderDialog();

    expect(screen.getByRole("heading").textContent).toContain("archive");
  });

  it("offers both paths without initializing anything yet", () => {
    renderDialog();

    expect(screen.getByText("Open without git")).toBeTruthy();
    expect(screen.getByText("Initialize repository")).toBeTruthy();
    // Mounting git setup early would start its progress subscription and
    // auto-close timer while the user is still deciding.
    expect(gitInitDialogSpy).not.toHaveBeenCalled();
  });

  it("adopts the folder when the user opens it without git", () => {
    const { props } = renderDialog();

    fireEvent.click(screen.getByText("Open without git"));

    expect(props.onOpenWithoutGit).toHaveBeenCalledTimes(1);
    expect(props.onInitSuccess).not.toHaveBeenCalled();
  });

  it("hands the same folder to git setup when that is chosen", () => {
    renderDialog();

    fireEvent.click(screen.getByText("Initialize repository"));

    expect(screen.getByTestId("git-init-dialog")).toBeTruthy();
    expect(gitInitDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ directoryPath: DIRECTORY })
    );
  });

  it("opens straight into git setup when asked to (sidebar upgrade)", () => {
    renderDialog({ initialStep: "initialize" });

    expect(screen.getByTestId("git-init-dialog")).toBeTruthy();
    expect(screen.queryByText("Open without git")).toBeNull();
  });

  it("keeps the chosen step until the dialog has closed", () => {
    const { rerender, props } = renderDialog();
    fireEvent.click(screen.getByText("Initialize repository"));

    // Closing animates out while still mounted; swapping the body back to the
    // choice screen mid-exit would flash the wrong content.
    rerender(<NonGitFolderDialog {...props} isOpen={false} />);
    rerender(<NonGitFolderDialog {...props} isOpen={true} />);

    expect(screen.getByText("Open without git")).toBeTruthy();
  });
});
