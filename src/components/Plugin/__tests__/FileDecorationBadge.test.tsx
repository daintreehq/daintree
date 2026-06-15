// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FileDecoration } from "@shared/types/forge";

const openExternalMock = vi.fn();
vi.mock("@/clients/systemClient", () => ({
  systemClient: { openExternal: (...args: unknown[]) => openExternalMock(...args) },
}));

async function load() {
  const { FileDecorationBadge } = await import("../FileDecorationBadge");
  return FileDecorationBadge;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FileDecorationBadge", () => {
  it("renders nothing when there is no decoration or no badge glyph", async () => {
    const FileDecorationBadge = await load();
    const { container, rerender } = render(<FileDecorationBadge decoration={undefined} />);
    expect(container.firstChild).toBeNull();
    rerender(<FileDecorationBadge decoration={{ tooltip: "no badge" }} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the provider badge with its tooltip as the accessible label", async () => {
    const FileDecorationBadge = await load();
    const deco: FileDecoration = { badge: "3", tooltip: "3 lint warnings" };
    render(<FileDecorationBadge decoration={deco} />);
    const el = screen.getByLabelText("3 lint warnings");
    expect(el.textContent).toBe("3");
    // No url → static marker, not a button.
    expect(el.tagName).toBe("SPAN");
  });

  it("becomes a button that opens the url through the protocol-checked openExternal", async () => {
    const FileDecorationBadge = await load();
    const deco: FileDecoration = { badge: "!", tooltip: "Open report", url: "https://x/report" };
    render(<FileDecorationBadge decoration={deco} />);
    const btn = screen.getByRole("button", { name: "Open report" });
    fireEvent.click(btn);
    expect(openExternalMock).toHaveBeenCalledWith("https://x/report");
  });
});
