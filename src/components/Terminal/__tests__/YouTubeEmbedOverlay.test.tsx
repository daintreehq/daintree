// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { YouTubeEmbedOverlay } from "../YouTubeEmbedOverlay";

const mockEmbeds = [{ videoId: "dQw4w9WgXcQ" }, { videoId: "abc12345678" }];
const mockDismiss = vi.fn();

vi.mock("@/hooks/useYouTubeEmbeds", () => ({
  useYouTubeEmbeds: vi.fn(() => ({
    embeds: mockEmbeds,
    dismissEmbed: mockDismiss,
  })),
}));

describe("YouTubeEmbedOverlay", () => {
  beforeEach(() => {
    mockDismiss.mockClear();
  });

  it("renders thumbnail cards for each embed", () => {
    render(<YouTubeEmbedOverlay terminalId="t1" cwd="/help" />);
    const expandButtons = screen.getAllByLabelText("Expand YouTube video");
    expect(expandButtons).toHaveLength(2);
  });

  it("renders nothing when embeds array is empty", async () => {
    const mod = await import("@/hooks/useYouTubeEmbeds");
    vi.mocked(mod.useYouTubeEmbeds).mockReturnValueOnce({
      embeds: [],
      dismissEmbed: mockDismiss,
    });
    const { container } = render(<YouTubeEmbedOverlay terminalId="t1" cwd="/help" />);
    expect(container.firstChild).toBeNull();
  });

  it("expands to iframe on click", () => {
    render(<YouTubeEmbedOverlay terminalId="t1" cwd="/help" />);
    const expandButtons = screen.getAllByLabelText("Expand YouTube video");
    fireEvent.click(expandButtons[0]);
    const iframe = screen.getByTitle("YouTube video");
    expect(iframe).toBeDefined();
    expect(iframe.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-presentation"
    );
  });

  it("calls dismissEmbed on dismiss button click", () => {
    render(<YouTubeEmbedOverlay terminalId="t1" cwd="/help" />);
    const dismissButtons = screen.getAllByLabelText("Dismiss embed");
    fireEvent.click(dismissButtons[0]);
    expect(mockDismiss).toHaveBeenCalledWith("dQw4w9WgXcQ");
  });
});
