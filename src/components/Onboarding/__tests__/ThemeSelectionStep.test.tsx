// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSetSelectedSchemeId = vi.fn();
const mockSetColorScheme = vi.fn((_id: string) => Promise.resolve());

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      selectedSchemeId: "daintree",
      setSelectedSchemeId: mockSetSelectedSchemeId,
    }),
}));

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: (id: string) => mockSetColorScheme(id),
  },
}));

import { ThemeSelectionStep } from "../ThemeSelectionStep";

describe("ThemeSelectionStep", () => {
  const defaultProps = {
    isOpen: true,
    onContinue: vi.fn(),
    onSkip: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(prefers-color-scheme: dark)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it("renders exactly two theme options (Daintree and Bondi)", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    expect(screen.getByText("Daintree")).toBeTruthy();
    expect(screen.getByText("Bondi")).toBeTruthy();
    expect(screen.queryByText("Fiordland")).toBeNull();
    expect(screen.queryByText("Highlands")).toBeNull();
  });

  it("shows dark and light labels", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    expect(screen.getByText("Dark")).toBeTruthy();
    expect(screen.getByText("Light")).toBeTruthy();
  });

  it("shows more themes hint", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    expect(screen.getByText(/More themes available in Settings/)).toBeTruthy();
  });

  it("calls setSelectedSchemeId and appThemeClient.setColorScheme on theme click", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    fireEvent.click(screen.getByText("Bondi"));
    expect(mockSetSelectedSchemeId).toHaveBeenCalledWith("bondi");
    expect(mockSetColorScheme).toHaveBeenCalledWith("bondi");
  });

  it("calls onContinue when Continue is clicked", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(defaultProps.onContinue).toHaveBeenCalled();
  });

  it("calls onSkip when Skip is clicked", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(defaultProps.onSkip).toHaveBeenCalled();
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = render(<ThemeSelectionStep {...defaultProps} isOpen={false} />);
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("auto-selects bondi when OS prefers light and current scheme is daintree", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(prefers-color-scheme: light)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    render(<ThemeSelectionStep {...defaultProps} />);
    expect(mockSetSelectedSchemeId).toHaveBeenCalledWith("bondi");
    expect(mockSetColorScheme).toHaveBeenCalledWith("bondi");
  });

  it("does not auto-select when already on OS-preferred scheme", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    expect(mockSetSelectedSchemeId).not.toHaveBeenCalled();
  });
});
