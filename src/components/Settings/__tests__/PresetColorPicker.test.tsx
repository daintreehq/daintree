// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { contrastRatio } from "@shared/theme";
import { PresetColorPicker } from "../PresetColorPicker";

// Mirrors the curated PALETTE inside PresetColorPicker. Kept here so the
// checkmark-contrast invariant below exercises every swatch.
const PALETTE = [
  "#e06c75",
  "#e5c07b",
  "#98c379",
  "#56b6c2",
  "#61afef",
  "#c678dd",
  "#be5046",
  "#d19a66",
  "#7c8fa8",
  "#abb2bf",
] as const;

vi.mock("lucide-react", () => ({
  Check: ({ className }: { className?: string }) => (
    <span data-testid="check-icon" className={className} />
  ),
  X: () => <span data-testid="x-icon" />,
}));

// Stub react-colorful: render simple controlled stand-ins so tests can drive
// onChange directly without relying on pointer-event simulation in jsdom.
// Note: the real HexColorInput only fires onChange for valid 3- or 6-char hex.
// This mock is permissive (passes any string through) — the malformed-hex test
// below exploits that to verify the Done-button guard, but in production the
// guard defends against round-tripping legacy 3-digit data, not typed garbage.
vi.mock("react-colorful", () => ({
  HexColorPicker: ({
    color,
    onChange,
    ...rest
  }: {
    color: string;
    onChange: (next: string) => void;
    [key: string]: unknown;
  }) => (
    <div
      {...rest}
      data-color={color}
      data-testid="hex-color-picker"
      onClick={() => onChange("#aabbcc")}
    />
  ),
  HexColorInput: ({
    color,
    onChange,
    prefixed,
    ...rest
  }: {
    color: string;
    onChange: (next: string) => void;
    prefixed?: boolean;
    [key: string]: unknown;
  }) => (
    <input
      {...rest}
      data-prefixed={prefixed ? "true" : "false"}
      value={color}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// Capture onOpenChange (to simulate dismissal-without-Done as a "cancel") and
// the latest `open` prop (to verify Done/Clear close the popover).
let capturedOnOpenChange: ((next: boolean) => void) | undefined;
let capturedOpen: boolean | undefined;

vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
  }) => {
    capturedOnOpenChange = onOpenChange;
    capturedOpen = open;
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("PresetColorPicker", () => {
  let onChange: ReturnType<typeof vi.fn<(color: string | undefined) => void>>;

  beforeEach(() => {
    onChange = vi.fn<(color: string | undefined) => void>();
    capturedOnOpenChange = undefined;
    capturedOpen = undefined;
  });

  it("trigger swatch reflects the current color", () => {
    const { getByTestId } = render(
      <PresetColorPicker color="#ff0000" onChange={onChange} agentColor="#888" />
    );
    const trigger = getByTestId("preset-color-picker-trigger");
    expect(trigger.querySelector("span")?.getAttribute("style")).toContain("rgb(255, 0, 0)");
  });

  it("trigger swatch falls back to agentColor when color is undefined", () => {
    const { getByTestId } = render(
      <PresetColorPicker color={undefined} onChange={onChange} agentColor="#0000ff" />
    );
    const trigger = getByTestId("preset-color-picker-trigger");
    expect(trigger.querySelector("span")?.getAttribute("style")).toContain("rgb(0, 0, 255)");
  });

  it("clicking a palette swatch updates draft only — does not call onChange", () => {
    const { container } = render(
      <PresetColorPicker color={undefined} onChange={onChange} agentColor="#888888" />
    );
    const swatch = container.querySelector(
      '[data-testid^="preset-color-swatch-"]'
    ) as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    fireEvent.click(swatch);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicking Done commits the draft color via onChange", () => {
    const { getByTestId } = render(
      <PresetColorPicker color={undefined} onChange={onChange} agentColor="#888888" />
    );
    fireEvent.click(getByTestId("preset-color-swatch-98c379"));
    fireEvent.click(getByTestId("preset-color-done"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("#98c379");
  });

  it("HexColorPicker drag updates draft and Done commits the new color", () => {
    const { getByTestId } = render(
      <PresetColorPicker color={undefined} onChange={onChange} agentColor="#888888" />
    );
    fireEvent.click(getByTestId("hex-color-picker")); // mock fires onChange("#aabbcc")
    fireEvent.click(getByTestId("preset-color-done"));
    expect(onChange).toHaveBeenCalledWith("#aabbcc");
  });

  it("clicking Clear invokes onChange with undefined", () => {
    const { getByTestId } = render(
      <PresetColorPicker color="#ff0000" onChange={onChange} agentColor="#888888" />
    );
    fireEvent.click(getByTestId("preset-color-clear"));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("dismissing the popover without Done does not call onChange", () => {
    const { getByTestId } = render(
      <PresetColorPicker color={undefined} onChange={onChange} agentColor="#888888" />
    );
    fireEvent.click(getByTestId("preset-color-swatch-e06c75"));
    expect(capturedOnOpenChange).toBeDefined();
    act(() => {
      capturedOnOpenChange!(false);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Done is disabled and a no-op when the draft hex is malformed", () => {
    const { getByTestId } = render(
      <PresetColorPicker color={undefined} onChange={onChange} agentColor="#888888" />
    );
    const hexInput = getByTestId("preset-color-hex-input") as HTMLInputElement;
    fireEvent.change(hexInput, { target: { value: "#zzz" } });
    const done = getByTestId("preset-color-done") as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(done);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("checkmark uses dark ink on a light swatch so it stays visible", () => {
    // #abb2bf (light gray, luminance ~0.44) — a white checkmark would wash out.
    const { getByTestId } = render(
      <PresetColorPicker color="#abb2bf" onChange={onChange} agentColor="#888888" />
    );
    expect(getByTestId("check-icon").className).toContain("text-black/80");
    expect(getByTestId("check-icon").className).not.toContain("text-white");
  });

  it("checkmark uses white ink on a dark swatch", () => {
    // #be5046 (dark red, luminance ~0.17) — white reads cleanly.
    const { getByTestId } = render(
      <PresetColorPicker color="#be5046" onChange={onChange} agentColor="#888888" />
    );
    expect(getByTestId("check-icon").className).toContain("text-white");
    expect(getByTestId("check-icon").className).not.toContain("text-black");
  });

  it.each(PALETTE)("checkmark ink on %s is the higher-contrast of black/white", (swatch) => {
    const { getByTestId } = render(
      <PresetColorPicker color={swatch} onChange={onChange} agentColor="#888888" />
    );
    const usesWhite = getByTestId("check-icon").className.includes("text-white");
    const whiteContrast = contrastRatio("#ffffff", swatch);
    const blackContrast = contrastRatio("#000000", swatch);
    // The rendered ink must be whichever achieves more contrast against the swatch.
    expect(usesWhite).toBe(whiteContrast >= blackContrast);
  });

  it("selected palette swatch is marked aria-pressed for the draft color", () => {
    const { getByTestId } = render(
      <PresetColorPicker color="#e06c75" onChange={onChange} agentColor="#888888" />
    );
    const swatch = getByTestId("preset-color-swatch-e06c75");
    expect(swatch.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking Done closes the popover", () => {
    const { getByTestId, rerender } = render(
      <PresetColorPicker color="#ff0000" onChange={onChange} agentColor="#888888" />
    );
    act(() => {
      capturedOnOpenChange!(true);
    });
    rerender(<PresetColorPicker color="#ff0000" onChange={onChange} agentColor="#888888" />);
    expect(capturedOpen).toBe(true);
    fireEvent.click(getByTestId("preset-color-done"));
    rerender(<PresetColorPicker color="#ff0000" onChange={onChange} agentColor="#888888" />);
    expect(capturedOpen).toBe(false);
    expect(onChange).toHaveBeenCalledWith("#ff0000");
  });

  it("3-digit hex prop is normalized to 6-digit on commit", () => {
    const { getByTestId } = render(
      <PresetColorPicker color="#abc" onChange={onChange} agentColor="#888888" />
    );
    fireEvent.click(getByTestId("preset-color-done"));
    expect(onChange).toHaveBeenCalledWith("#aabbcc");
  });

  it("re-opening the popover resets the draft to the committed color", () => {
    const { getByTestId } = render(
      <PresetColorPicker color="#ff0000" onChange={onChange} agentColor="#888888" />
    );
    // Drag to a new draft color, then dismiss without committing.
    fireEvent.click(getByTestId("hex-color-picker"));
    act(() => {
      capturedOnOpenChange!(false);
    });
    // Re-open: draft should snap back to the prop color (#ff0000), not the
    // dragged value. Verified via the hex input since the picker stub doesn't
    // expose its color reactively.
    act(() => {
      capturedOnOpenChange!(true);
    });
    const hexInput = getByTestId("preset-color-hex-input") as HTMLInputElement;
    expect(hexInput.value).toBe("#ff0000");
  });
});
