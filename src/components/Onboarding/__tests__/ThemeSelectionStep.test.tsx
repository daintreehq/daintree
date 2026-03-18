// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSetSelectedSchemeId = vi.fn();
const mockSetColorScheme = vi.fn(() => Promise.resolve());

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      selectedSchemeId: "daintree",
      setSelectedSchemeId: mockSetSelectedSchemeId,
    }),
}));

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: (...args: unknown[]) => mockSetColorScheme(...args),
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
  });

  it("renders dark and light section headers", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    expect(screen.getByText("Dark")).toBeTruthy();
    expect(screen.getByText("Light")).toBeTruthy();
  });

  it("renders all 12 built-in theme buttons", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    expect(screen.getByText("Daintree")).toBeTruthy();
    expect(screen.getByText("Fiordland")).toBeTruthy();
    expect(screen.getByText("Highlands")).toBeTruthy();
    expect(screen.getByText("Arashiyama")).toBeTruthy();
    expect(screen.getByText("Galápagos")).toBeTruthy();
    expect(screen.getByText("Namib")).toBeTruthy();
    expect(screen.getByText("Redwoods")).toBeTruthy();
    expect(screen.getByText("Bondi")).toBeTruthy();
    expect(screen.getByText("Svalbard")).toBeTruthy();
    expect(screen.getByText("Atacama")).toBeTruthy();
    expect(screen.getByText("Serengeti")).toBeTruthy();
    expect(screen.getByText("Hokkaido")).toBeTruthy();
  });

  it("calls setSelectedSchemeId and appThemeClient.setColorScheme on theme click", () => {
    render(<ThemeSelectionStep {...defaultProps} />);
    fireEvent.click(screen.getByText("Fiordland"));
    expect(mockSetSelectedSchemeId).toHaveBeenCalledWith("fiordland");
    expect(mockSetColorScheme).toHaveBeenCalledWith("fiordland");
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
});
