// @vitest-environment jsdom
import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DownloadDiagnosticsSection } from "../TroubleshootingTab";
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

// Marked so the busy glyph can be identified by component identity rather than
// by its class strings — asserting `animate-spin` would just copy the literal
// back out of Spinner.tsx. Button imports Spinner too, but only for its
// `loading` overlay, which this section never enables.
vi.mock("@/components/ui/Spinner", () => ({
  Spinner: () => <span data-testid="busy-spinner" />,
}));

const setCollecting = (isCollecting: boolean) => {
  act(() => {
    useDiagnosticsReviewStore.setState({ isCollecting });
  });
};

const getButton = () => screen.getByRole<HTMLButtonElement>("button");
const spinner = () => screen.queryByTestId("busy-spinner");
// Scoped to the button: SettingsSection renders its own Download glyph in the
// section heading, which is not part of the busy state under test.
const glyph = () => getButton().querySelector("svg");

describe("DownloadDiagnosticsSection — collecting state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiagnosticsReviewStore.setState({ isCollecting: false, downloadError: null });
  });

  it("shows an action glyph and no spinner while idle", () => {
    render(<DownloadDiagnosticsSection />);

    expect(glyph()).not.toBeNull();
    expect(spinner()).toBeNull();
  });

  it("swaps the action glyph for the spinner while collecting", () => {
    render(<DownloadDiagnosticsSection />);
    setCollecting(true);

    // The bug being fixed was a single glyph that spun in place. The two
    // indicators must be mutually exclusive, not layered.
    expect(spinner()).not.toBeNull();
    expect(glyph()).toBeNull();
  });

  it("restores the action glyph once collecting ends", () => {
    render(<DownloadDiagnosticsSection />);
    setCollecting(true);
    setCollecting(false);

    expect(spinner()).toBeNull();
    expect(glyph()).not.toBeNull();
  });

  it("swaps the label when collecting starts", () => {
    render(<DownloadDiagnosticsSection />);
    const idleLabel = getButton().textContent;

    setCollecting(true);

    expect(getButton().textContent).not.toBe(idleLabel);
  });

  it("ends the busy label with a real ellipsis rather than three periods", () => {
    render(<DownloadDiagnosticsSection />);
    setCollecting(true);

    const busyLabel = getButton().textContent ?? "";
    expect(busyLabel).toMatch(/…$/);
    expect(busyLabel).not.toContain("...");
  });

  it("writes the idle label in sentence case", () => {
    render(<DownloadDiagnosticsSection />);

    // Sentence case as an invariant, not a copy of the literal: every word
    // after the first stays lowercase.
    const words = (getButton().textContent ?? "").trim().split(/\s+/);
    expect(words.length).toBeGreaterThan(1);
    expect(words.slice(1).every((word) => word === word.toLowerCase())).toBe(true);
  });

  it("disables the button only while collecting", () => {
    render(<DownloadDiagnosticsSection />);
    expect(getButton().disabled).toBe(false);

    setCollecting(true);
    expect(getButton().disabled).toBe(true);

    setCollecting(false);
    expect(getButton().disabled).toBe(false);
  });

  it("renders the collection failure message from the store", () => {
    render(<DownloadDiagnosticsSection />);
    act(() => {
      useDiagnosticsReviewStore.setState({ downloadError: "disk full" });
    });

    expect(screen.getByText("disk full")).toBeTruthy();
  });
});
