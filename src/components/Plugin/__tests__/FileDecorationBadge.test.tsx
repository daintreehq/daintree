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

  it("applies provider color as a className token, not an inline style", async () => {
    const FileDecorationBadge = await load();
    // Per the FileDecoration.color contract the value is an opaque class token
    // passed to className — it must not land in the inline style attribute.
    const deco: FileDecoration = { badge: "3", tooltip: "warn", color: "text-status-warning" };
    render(<FileDecorationBadge decoration={deco} />);
    const el = screen.getByLabelText("warn");
    expect(el.className).toContain("text-status-warning");
    expect(el.getAttribute("style")).toBeNull();
  });

  it("stops a url-badge click from bubbling to an enclosing row handler", async () => {
    const FileDecorationBadge = await load();
    const parentClick = vi.fn();
    const deco: FileDecoration = { badge: "↗", tooltip: "Open PR", url: "https://x/pr" };
    render(
      <div onClick={parentClick}>
        <FileDecorationBadge decoration={deco} />
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: "Open PR" }));
    expect(openExternalMock).toHaveBeenCalledWith("https://x/pr");
    expect(parentClick).not.toHaveBeenCalled();
  });
});
