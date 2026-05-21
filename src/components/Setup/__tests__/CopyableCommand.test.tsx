// @vitest-environment jsdom
import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CopyableCommand } from "../CopyableCommand";

const openExternalMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/clients/systemClient", () => ({
  systemClient: {
    openExternal: (...args: unknown[]) => openExternalMock(...args),
  },
}));

const writeTextMock = vi.fn().mockResolvedValue(undefined);

function renderWithProviders(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("CopyableCommand", () => {
  beforeEach(() => {
    openExternalMock.mockClear();
    writeTextMock.mockClear();
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the command text", () => {
    renderWithProviders(<CopyableCommand command="brew install kiro" />);
    expect(screen.getByText("brew install kiro")).toBeTruthy();
  });

  it("does not render the inspect button when inspectUrl is omitted", () => {
    renderWithProviders(<CopyableCommand command="brew install kiro" />);
    expect(screen.queryByLabelText("Inspect install script in browser")).toBeNull();
  });

  it("renders the inspect button when inspectUrl is provided", () => {
    renderWithProviders(
      <CopyableCommand
        command="curl https://kiro.dev/install.sh | bash"
        inspectUrl="https://kiro.dev/install.sh"
      />
    );
    expect(screen.getByLabelText("Inspect install script in browser")).toBeTruthy();
  });

  it("opens the inspect URL externally when the inspect button is clicked", () => {
    renderWithProviders(
      <CopyableCommand
        command="curl https://kiro.dev/install.sh | bash"
        inspectUrl="https://kiro.dev/install.sh"
      />
    );
    fireEvent.click(screen.getByLabelText("Inspect install script in browser"));
    expect(openExternalMock).toHaveBeenCalledWith("https://kiro.dev/install.sh");
  });

  it("strips paste-jacking characters before writing to the clipboard", async () => {
    renderWithProviders(<CopyableCommand command={"npm install foo\nrm -rf /"} />);
    fireEvent.click(screen.getByLabelText("Copy command to clipboard"));
    // Microtask drain so the awaited writeText resolves before the assertion.
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledWith("npm install foorm -rf /");
  });

  it("passes a clean command through to the clipboard unchanged", async () => {
    renderWithProviders(<CopyableCommand command="brew install kiro" />);
    fireEvent.click(screen.getByLabelText("Copy command to clipboard"));
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledWith("brew install kiro");
  });
});
