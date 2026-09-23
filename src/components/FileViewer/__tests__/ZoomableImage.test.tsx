// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fitScale, ZoomableImage } from "../ZoomableImage";

describe("fitScale", () => {
  it("never reports more than actual size — fitting only ever shrinks", () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 800, height: 800 })).toBe(1);
  });

  it("is limited by whichever axis runs out first", () => {
    const natural = { width: 1200, height: 600 };
    const scale = fitScale(natural, { width: 600, height: 600 });
    expect(natural.width * scale).toBeLessThanOrEqual(600);
    expect(natural.height * scale).toBeLessThanOrEqual(600);
    expect(scale).toBeLessThan(1);
  });

  it("falls back to 1 when either size is unknown", () => {
    expect(fitScale(null, { width: 10, height: 10 })).toBe(1);
    expect(fitScale({ width: 10, height: 10 }, null)).toBe(1);
  });
});

describe("ZoomableImage keyboard", () => {
  function renderImage() {
    render(
      <TooltipProvider>
        <ZoomableImage filePath="/repo/a.png" rootPath="/repo" alt="a.png" />
      </TooltipProvider>
    );
    return screen.getByRole("group", { name: /^a\.png/ });
  }

  it("pans with the arrow keys and returns to fit on 0", () => {
    const stage = renderImage();
    const image = screen.getByRole("img", { name: "a.png" });

    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    const panned = image.style.transform;
    expect(panned).not.toBe("translate(0px, 0px) scale(1)");
    expect(screen.getByRole("button", { name: "Fit to screen" }).hasAttribute("disabled")).toBe(
      false
    );

    fireEvent.keyDown(stage, { key: "0" });
    expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("zooms with + and -", () => {
    const stage = renderImage();
    const image = screen.getByRole("img", { name: "a.png" });
    fireEvent.keyDown(stage, { key: "+" });
    expect(image.style.transform).not.toContain("scale(1)");
    fireEvent.keyDown(stage, { key: "-" });
    expect(image.style.transform).toContain("scale(1)");
  });
});
