// @vitest-environment jsdom
import type { CSSProperties } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@shared/theme";
import { BrandMark } from "../BrandMark";

// The resolver is a pure function of the hex, so it runs for real here rather
// than through a mock — there is no scheme to stub, and a mock would only
// re-create the shape drift it used to hide.

function TestIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return <svg data-testid="icon" className={className} style={style} />;
}

describe("BrandMark", () => {
  describe("without a usable color", () => {
    it("forwards className onto the child SVG and adds no wrapper", () => {
      const { getByTestId, container } = render(
        <BrandMark className="w-3.5 h-3.5 mr-2">
          <TestIcon />
        </BrandMark>
      );

      expect(container.querySelector("span")).toBeNull();
      expect(getByTestId("icon").getAttribute("class")).toBe("w-3.5 h-3.5 mr-2");
    });

    it("merges existing child className with the BrandMark className", () => {
      const { getByTestId } = render(
        <BrandMark className="mr-2">
          <TestIcon className="text-status-info" />
        </BrandMark>
      );

      expect(getByTestId("icon").getAttribute("class")).toBe("text-status-info mr-2");
    });

    it("renders bare child unchanged when no className is supplied", () => {
      const { getByTestId, container } = render(
        <BrandMark>
          <TestIcon />
        </BrandMark>
      );

      expect(container.querySelector("span")).toBeNull();
      expect(getByTestId("icon").hasAttribute("class")).toBe(false);
    });

    it("falls back to the inherited glyph for an unparseable color", () => {
      const { container } = render(
        <BrandMark brandColor="not-a-color">
          <TestIcon />
        </BrandMark>
      );

      expect(container.querySelector("span")).toBeNull();
    });
  });

  describe("with a brand color", () => {
    it("paints the tile in the exact color and sets a contrasting ink", () => {
      const { container } = render(
        <BrandMark brandColor="#CC785C">
          <TestIcon />
        </BrandMark>
      );

      const span = container.querySelector("span");
      expect(span).not.toBeNull();
      const { backgroundColor, color } = (span as HTMLElement).style;
      // jsdom normalizes hex to rgb(); compare through the same lens.
      expect(backgroundColor).toBe("rgb(204, 120, 92)");
      // The ink must be one of the two candidates AND the better of them — an
      // empty or stray color would otherwise be credited with black's contrast.
      const inks = { "rgb(255, 255, 255)": "#FFFFFF", "rgb(0, 0, 0)": "#000000" } as const;
      const ink = inks[color as keyof typeof inks];
      expect(ink).toBeDefined();
      const other = ink === "#FFFFFF" ? "#000000" : "#FFFFFF";
      expect(contrastRatio(ink, "#CC785C")).toBeGreaterThan(contrastRatio(other, "#CC785C"));
    });

    it("treats a preset color exactly like a built-in one", () => {
      // A deliberate preset color used to fork onto its own path here; it now
      // takes the same one, which is what keeps it unmodified on both polarities.
      const preset = render(
        <BrandMark brandColor="#000000">
          <TestIcon />
        </BrandMark>
      ).container.querySelector("span") as HTMLElement;

      expect(preset.style.backgroundColor).toBe("rgb(0, 0, 0)");
      expect(preset.style.color).toBe("rgb(255, 255, 255)");
    });

    it("rings the tile so an achromatic mark still has an edge", () => {
      const { container } = render(
        <BrandMark brandColor="#111111">
          <TestIcon />
        </BrandMark>
      );

      // A dark tile needs a light ring, and it has to be translucent — an opaque
      // or same-polarity ring is not the edge this is here to draw.
      expect((container.querySelector("span") as HTMLElement).style.boxShadow).toBe(
        "inset 0 0 0 1px rgba(255, 255, 255, 0.15)"
      );
    });

    it("applies className to the wrapper and sizes the glyph inside it", () => {
      const { getByTestId, container } = render(
        <BrandMark brandColor="#10a37f" className="w-3.5 h-3.5 mr-2">
          <TestIcon />
        </BrandMark>
      );

      expect(container.querySelector("span")?.getAttribute("class")).toContain("mr-2");
      // The glyph is sized against the tile rather than carrying its own size,
      // so a caller that sized by class and one that sized by prop both work.
      expect(getByTestId("icon").style.width).toBe("75%");
    });

    it("infers a box only when the caller gave neither size prop nor size class", () => {
      // Unsized: the badge has to declare a square box of its own, or it would
      // collapse to the glyph's intrinsic size and lose the tile.
      const inferred = render(
        <BrandMark brandColor="#10a37f">
          <TestIcon />
        </BrandMark>
      ).container.querySelector("span") as HTMLElement;
      expect(inferred.style.width).toBeTruthy();
      expect(inferred.style.height).toBe(inferred.style.width);

      // An explicit size is echoed in both dimensions rather than inferred over.
      const explicit = render(
        <BrandMark brandColor="#10a37f" size={24}>
          <TestIcon />
        </BrandMark>
      ).container.querySelector("span") as HTMLElement;
      expect([explicit.style.width, explicit.style.height]).toEqual(["24px", "24px"]);

      // Sized by class: no inline box, so the class stays in control.
      const sized = render(
        <BrandMark brandColor="#10a37f" className="w-8 h-8">
          <TestIcon />
        </BrandMark>
      ).container.querySelector("span") as HTMLElement;
      expect(sized.style.width).toBe("");
    });

    it("hides the decorative wrapper from assistive tech", () => {
      const { container } = render(
        <BrandMark brandColor="#10a37f">
          <TestIcon />
        </BrandMark>
      );
      expect(container.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
    });
  });
});
