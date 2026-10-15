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

  it("renders the provider glyph as presentation only, never as a control", async () => {
    const FileDecorationBadge = await load();
    // It sits inside a row that is itself a button, whose children are
    // presentational: the row carries the words and owns the tab stop.
    const { container, rerender } = render(
      <FileDecorationBadge decoration={{ badge: "3", tooltip: "3 lint warnings" }} />
    );
    const el = screen.getByText("3");
    expect(el.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(el.getAttribute("title")).toBeNull();
    rerender(
      <FileDecorationBadge
        decoration={{ badge: "!", tooltip: "Open report", url: "https://x/r" }}
      />
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(container.querySelector("[tabindex]")).toBeNull();
  });

  it("opens a url badge through the protocol-checked openExternal", async () => {
    const FileDecorationBadge = await load();
    const deco: FileDecoration = { badge: "!", tooltip: "Open report", url: "https://x/report" };
    render(<FileDecorationBadge decoration={deco} />);
    fireEvent.click(screen.getByText("!"));
    expect(openExternalMock).toHaveBeenCalledWith("https://x/report");
  });

  it("applies provider color as a className token, not an inline style", async () => {
    const FileDecorationBadge = await load();
    // Per the FileDecoration.color contract the value is an opaque class token
    // passed to className — it must not land in the inline style attribute.
    const deco: FileDecoration = { badge: "3", tooltip: "warn", color: "text-status-warning" };
    render(<FileDecorationBadge decoration={deco} />);
    const el = screen.getByText("3");
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
    fireEvent.click(screen.getByText("↗"));
    expect(openExternalMock).toHaveBeenCalledWith("https://x/pr");
    expect(parentClick).not.toHaveBeenCalled();
  });
});
