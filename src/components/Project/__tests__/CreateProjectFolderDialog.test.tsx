/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";

const { createProjectFolderMock, openDialogMock, getHomeDirMock } = vi.hoisted(() => ({
  createProjectFolderMock: vi.fn(),
  openDialogMock: vi.fn(),
  getHomeDirMock: vi.fn(),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/clients", () => ({
  projectClient: { openDialog: openDialogMock },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ createProjectFolder: createProjectFolderMock }),
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

  const AppDialog = ({ isOpen, children }: AppDialogMockProps) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;

  AppDialog.Header = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: SectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.Body = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Footer = ({ children, hint }: SectionProps & { hint?: ReactNode }) => (
    <div>
      {hint}
      {children}
    </div>
  );

  return { AppDialog };
});

// Render the picker inline so a selection can be driven without Radix layout.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({ onEmojiSelect }: { onEmojiSelect: (e: { emoji: string }) => void }) => (
    <button type="button" onClick={() => onEmojiSelect({ emoji: "🦄" })}>
      pick-unicorn
    </button>
  ),
}));

import { CreateProjectFolderDialog } from "../CreateProjectFolderDialog";

function emojiTrigger() {
  return screen.getByRole("button", { name: /choose project emoji/i });
}

function folderInput() {
  return screen.getByLabelText<HTMLInputElement>(/^name$/i);
}

async function renderDialog() {
  const onClose = vi.fn();
  const result = render(<CreateProjectFolderDialog isOpen={true} onClose={onClose} />);
  // The dialog resolves the home directory on open; wait for it to land, or the
  // Create button stays disabled on a missing parent path.
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLInputElement>(/^location$/i).value).toBe("/Users/test")
  );
  return { onClose, ...result };
}

describe("CreateProjectFolderDialog validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHomeDirMock.mockResolvedValue("/Users/test");
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { system: { getHomeDir: getHomeDirMock } },
    });
  });

  it("flags an invalid name as it is typed and never offers it as the destination", async () => {
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "helios:dashboard" } });

    expect(folderInput().getAttribute("aria-invalid")).toBe("true");
    const describedBy = folderInput().getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBeTruthy();
    // Typing never interrupts: the live check is announced through the field.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTitle("/Users/test/helios:dashboard")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create folder" }).disabled).toBe(
      true
    );
  });
});

describe("CreateProjectFolderDialog identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHomeDirMock.mockResolvedValue("/Users/test");
    createProjectFolderMock.mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { system: { getHomeDir: getHomeDirMock } },
    });
  });

  it("shows the unset tree before a folder name is typed", async () => {
    await renderDialog();
    expect(emojiTrigger().textContent).toBe(DEFAULT_PROJECT_EMOJI);
  });

  it("suggests an emoji derived from the folder name", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "my-api" } });

    expect(emojiTrigger().textContent).toBe(suggestProjectEmoji("my-api"));
    expect(emojiTrigger().textContent).not.toBe(DEFAULT_PROJECT_EMOJI);
  });

  it("updates the suggestion as the folder name changes", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "docs" } });
    const forDocs = emojiTrigger().textContent;
    fireEvent.change(folderInput(), { target: { value: "mobile" } });

    expect(emojiTrigger().textContent).not.toBe(forDocs);
    expect(emojiTrigger().textContent).toBe(suggestProjectEmoji("mobile"));
  });

  it("stops re-suggesting once the user picks explicitly", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "docs" } });
    fireEvent.click(screen.getByText("pick-unicorn"));
    expect(emojiTrigger().textContent).toBe("🦄");

    // A later rename must not clobber the deliberate choice.
    fireEvent.change(folderInput(), { target: { value: "mobile" } });
    expect(emojiTrigger().textContent).toBe("🦄");
  });

  it("submits the folder name together with the explicitly chosen emoji", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "my-api" } });
    fireEvent.click(screen.getByText("pick-unicorn"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create folder$/i }));
    });

    expect(createProjectFolderMock).toHaveBeenCalledWith("/Users/test", "my-api", "🦄", {
      disposition: "current",
    });
  });

  it("submits the suggested emoji when the user leaves it alone", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "my-api" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create folder$/i }));
    });

    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-api",
      suggestProjectEmoji("my-api"),
      { disposition: "current" }
    );
  });
});

describe("CreateProjectFolderDialog destination (#12594)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHomeDirMock.mockResolvedValue("/Users/test");
    createProjectFolderMock.mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { system: { getHomeDir: getHomeDirMock } },
    });
  });

  it("asks where the project opens before creating it, defaulting to this window", async () => {
    await renderDialog();

    const group = screen.getByRole("radiogroup", { name: "Open in" });
    const thisWindow = screen.getByRole("radio", { name: "This window" });
    expect(group.contains(thisWindow)).toBe(true);
    expect(thisWindow.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "New window" }).getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("carries a New window choice into the create call", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "my-api" } });
    fireEvent.click(screen.getByRole("radio", { name: "New window" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create folder$/i }));
    });

    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-api",
      suggestProjectEmoji("my-api"),
      { disposition: "new" }
    );
  });

  it("starts the next open back on this window", async () => {
    const { rerender } = await renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "New window" }));

    rerender(<CreateProjectFolderDialog isOpen={false} onClose={vi.fn()} />);
    rerender(<CreateProjectFolderDialog isOpen={true} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "This window" }).getAttribute("aria-checked")).toBe(
        "true"
      )
    );
  });
});
