// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrandMark } from "../BrandMark";
import { BrandSurface, BrandSurfaceReset } from "../BrandSurface";

const resolveInkMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/brandIcon", () => ({
  resolveBrandMarkInk: resolveInkMock,
}));
vi.mock("@/hooks/useActiveAppScheme", () => ({
  useActiveAppScheme: () => ({ type: "dark", tokens: {} }),
}));

function TestIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <svg data-testid="icon" className={className} style={style} />;
}

const INK = { rest: "#9a8b84", active: "#cc785c" };

beforeEach(() => {
  resolveInkMock.mockReset();
});

describe("BrandMark", () => {
  it("publishes both inks as custom properties on the glyph", () => {
    resolveInkMock.mockReturnValue(INK);

    const { getByTestId } = render(
      <BrandMark brandColor="#cc785c">
        <TestIcon />
      </BrandMark>
    );

    const icon = getByTestId("icon");
    expect(icon.style.getPropertyValue("--brand-mark-rest")).toBe(INK.rest);
    expect(icon.style.getPropertyValue("--brand-mark-active")).toBe(INK.active);
    expect(icon.getAttribute("class")).toContain("brand-mark");
  });

  it("never sets colour inline, so the active rule can win", () => {
    // An inline `color` outranks `button:hover .brand-mark` and would strand the
    // mark at its resting colour for the whole interaction.
    resolveInkMock.mockReturnValue(INK);

    const { getByTestId } = render(
      <BrandMark brandColor="#cc785c">
        <TestIcon />
      </BrandMark>
    );

    const { style } = getByTestId("icon");
    expect(style.color).toBe("");
    expect(style.backgroundColor).toBe("");
    expect(style.filter).toBe("");
  });

  it("hands the resolver the whole surface descriptor, not part of it", () => {
    // The bug this pins shipped once: the provider destructured `surface` and
    // `lift` and quietly dropped `extension`, so the panel-header backgrounds
    // several light themes paint never reached the resolver and every mark in a
    // title bar was measured against a colour that was not on screen. Resolver
    // tests could not see it — they pass the descriptor directly.
    resolveInkMock.mockReturnValue(INK);

    render(
      <BrandSurface surface="surface-panel" extension="panel-header-focus-bg" lift="overlay-subtle">
        <BrandMark brandColor="#cc785c">
          <TestIcon />
        </BrandMark>
      </BrandSurface>
    );

    expect(resolveInkMock).toHaveBeenCalledWith("#cc785c", expect.anything(), {
      surface: "surface-panel",
      extension: "panel-header-focus-bg",
      lift: "overlay-subtle",
    });
  });

  it("withdraws the surface for floating material", () => {
    // Context reaches through a portal even though the DOM does not, so a menu
    // opened from the toolbar would measure against the toolbar without this.
    resolveInkMock.mockReturnValue(INK);

    render(
      <BrandSurface surface="surface-toolbar">
        <BrandSurfaceReset>
          <BrandMark brandColor="#cc785c">
            <TestIcon />
          </BrandMark>
        </BrandSurfaceReset>
      </BrandSurface>
    );

    expect(resolveInkMock).toHaveBeenCalledWith("#cc785c", expect.anything(), null);
  });

  it("renders no wrapper element around the glyph", () => {
    // The tile is what #11903 backed out: a mark is a glyph, not a plate.
    resolveInkMock.mockReturnValue(INK);

    const { container } = render(
      <BrandMark brandColor="#cc785c">
        <TestIcon />
      </BrandMark>
    );

    expect(container.querySelector("span")).toBeNull();
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("preserves styles the child already carried", () => {
    resolveInkMock.mockReturnValue(INK);

    const { getByTestId } = render(
      <BrandMark brandColor="#cc785c">
        <TestIcon style={{ opacity: 0.5 }} />
      </BrandMark>
    );

    const { style } = getByTestId("icon");
    expect(style.opacity).toBe("0.5");
    expect(style.getPropertyValue("--brand-mark-rest")).toBe(INK.rest);
  });

  it("forwards className onto the child SVG", () => {
    resolveInkMock.mockReturnValue(null);

    const { getByTestId, container } = render(
      <BrandMark className="w-3.5 h-3.5 mr-2">
        <TestIcon />
      </BrandMark>
    );

    expect(container.querySelector("span")).toBeNull();
    expect(getByTestId("icon").getAttribute("class")).toBe("w-3.5 h-3.5 mr-2");
  });

  it("merges existing child className with the BrandMark className", () => {
    resolveInkMock.mockReturnValue(null);

    const { getByTestId } = render(
      <BrandMark className="mr-2">
        <TestIcon className="text-status-info" />
      </BrandMark>
    );

    expect(getByTestId("icon").getAttribute("class")).toBe("text-status-info mr-2");
  });

  it("preserves child size classes when BrandMark adds spacing (DockLaunchMenuItems shape)", () => {
    resolveInkMock.mockReturnValue(null);

    const { getByTestId } = render(
      <BrandMark className="w-3.5 h-3.5 mr-2">
        <TestIcon className="w-3.5 h-3.5" />
      </BrandMark>
    );

    expect(getByTestId("icon").getAttribute("class")).toBe("w-3.5 h-3.5 mr-2");
  });

  it("leaves the child untouched when no ink resolves and nothing is added", () => {
    resolveInkMock.mockReturnValue(null);

    const { getByTestId } = render(
      <BrandMark>
        <TestIcon />
      </BrandMark>
    );

    const icon = getByTestId("icon");
    expect(icon.hasAttribute("class")).toBe(false);
    expect(icon.style.getPropertyValue("--brand-mark-rest")).toBe("");
  });

  it("tags the glyph only when an ink actually resolved", () => {
    // A generic or plugin glyph reaching BrandMark without a brand hex must keep
    // inheriting its context's colour rather than resolving to an empty variable.
    resolveInkMock.mockReturnValue(null);

    const { getByTestId } = render(
      <BrandMark className="mr-2">
        <TestIcon />
      </BrandMark>
    );

    expect(getByTestId("icon").getAttribute("class")).not.toContain("brand-mark");
  });
});
