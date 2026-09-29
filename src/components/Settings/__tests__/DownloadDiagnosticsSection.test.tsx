// @vitest-environment jsdom
import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DownloadDiagnosticsSection } from "../TroubleshootingTab";
import { Spinner } from "@/components/ui/Spinner";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";

const mockDispatch = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
  ok: true,
  result: undefined,
});

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

// Spied, not replaced: the real Spinner still renders its SVG, so the busy glyph
// is identified by component identity rather than by class strings (asserting
// `animate-spin` would just copy the literal back out of Spinner.tsx). Button
// imports this same module for its `loading` overlay, which this section never
// enables — so every recorded call belongs to the section under test.
vi.mock("@/components/ui/Spinner", { spy: true });

const spinner = () => vi.mocked(Spinner);

const setCollecting = (isCollecting: boolean) => {
  act(() => {
    useDiagnosticsReviewStore.setState({ isCollecting });
  });
};

const getButton = () => screen.getByRole<HTMLButtonElement>("button");
// Scoped to the button: the only glyph it ever holds is the busy spinner.
const glyphCount = () => getButton().querySelectorAll("svg").length;

describe("DownloadDiagnosticsSection — collecting state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiagnosticsReviewStore.setState({ isCollecting: false, downloadError: null });
  });

  it("shows no glyph and no spinner while idle", () => {
    render(<DownloadDiagnosticsSection />);

    expect(spinner()).not.toHaveBeenCalled();
    expect(glyphCount()).toBe(0);
  });

  it("shows the spinner while collecting", () => {
    render(<DownloadDiagnosticsSection />);
    setCollecting(true);

    // The bug being fixed was one glyph spinning in place. The spinner must be
    // rendered, and only once — exactly one SVG while busy.
    expect(spinner()).toHaveBeenCalled();
    expect(glyphCount()).toBe(1);
  });

  it("drops the spinner once collecting ends", () => {
    render(<DownloadDiagnosticsSection />);
    setCollecting(true);
    spinner().mockClear();
    setCollecting(false);

    expect(spinner()).not.toHaveBeenCalled();
    expect(glyphCount()).toBe(0);
  });

  // Busy is the Button's `loading` state: the label stays put (it holds the
  // width and the accessible name) and the button keeps keyboard focus.
  it("keeps the label while collecting", () => {
    render(<DownloadDiagnosticsSection />);
    const idleLabel = getButton().textContent;

    setCollecting(true);

    expect(getButton().textContent).toBe(idleLabel);
  });

  it("marks the button busy only while collecting, without natively disabling it", () => {
    render(<DownloadDiagnosticsSection />);
    expect(getButton().getAttribute("aria-busy")).toBeNull();

    setCollecting(true);
    expect(getButton().getAttribute("aria-busy")).toBe("true");
    expect(getButton().getAttribute("aria-disabled")).toBe("true");
    expect(getButton().disabled).toBe(false);

    setCollecting(false);
    expect(getButton().getAttribute("aria-busy")).toBeNull();
  });

  it("renders the collection failure message from the store", () => {
    render(<DownloadDiagnosticsSection />);
    act(() => {
      useDiagnosticsReviewStore.setState({ downloadError: "disk full" });
    });

    expect(screen.getByText("disk full")).toBeTruthy();
  });
});
