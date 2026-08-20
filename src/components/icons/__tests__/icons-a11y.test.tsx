// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DaintreeIcon } from "../DaintreeIcon";
import {
  SpinnerCircle as DirectSpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
} from "../AgentStateCircles";
// Re-imported via the barrel to regression-test `export * from "./AgentStateCircles"`.
import { SpinnerCircle } from "../index";
import { CheckCircle2 } from "lucide-react";
import { ClaudeIcon } from "../brands/ClaudeIcon";
import { NpmIcon } from "../brands/NpmIcon";
import { InterpreterIcon } from "../brands/InterpreterIcon";
import { GooseIcon } from "../brands/GooseIcon";
import { PythonIcon } from "../brands/PythonIcon";
import { DockerIcon } from "../brands/DockerIcon";
import { AiderIcon } from "../brands/AiderIcon";

describe("DaintreeIcon a11y", () => {
  it("is decorative and exposes no aria-label", () => {
    const { container } = render(<DaintreeIcon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.hasAttribute("aria-label")).toBe(false);
  });
});

describe("AgentStateCircles a11y", () => {
  it.each([
    ["SpinnerCircle", DirectSpinnerCircle],
    ["HollowCircle", HollowCircle],
    ["InteractingCircle", InteractingCircle],
    ["ExitedCircle", ExitedCircle],
  ])("%s defaults to aria-hidden='true'", (_name, Component) => {
    const { container } = render(<Component />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each([
    ["SpinnerCircle", DirectSpinnerCircle],
    ["HollowCircle", HollowCircle],
    ["InteractingCircle", InteractingCircle],
    ["ExitedCircle", ExitedCircle],
  ])("%s allows callers to override aria-hidden and supply a label", (_name, Component) => {
    const { container } = render(
      <Component aria-hidden={undefined} role="img" aria-label="Working" />
    );
    const svg = container.querySelector("svg");
    expect(svg?.hasAttribute("aria-hidden")).toBe(false);
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Working");
  });

  // Regression guard for #9705: the custom circles share a 16-unit viewBox while
  // Lucide icons use a 24-unit one. The rendered line weight is strokeWidth/viewBox,
  // so the chips only match Lucide visually when that ratio is equal. Asserting the
  // ratio (a relationship between two icons read from the DOM), not the literal
  // strokeWidth, keeps this from being a tautological style test: it fails if either
  // icon's strokeWidth or viewBox drifts out of alignment with the other.
  const strokeRatio = (svg: SVGSVGElement, strokeHost: Element | null) => {
    const viewBoxWidth = Number(svg.getAttribute("viewBox")!.split(/\s+/)[2]);
    const strokeWidth = parseFloat(strokeHost!.getAttribute("stroke-width")!);
    return strokeWidth / viewBoxWidth;
  };

  it.each([
    ["SpinnerCircle", DirectSpinnerCircle],
    ["HollowCircle", HollowCircle],
    ["InteractingCircle", InteractingCircle],
    ["ExitedCircle", ExitedCircle],
  ])("%s renders the same stroke weight as a Lucide icon at any size", (_name, Component) => {
    const { container: custom } = render(<Component />);
    const customSvg = custom.querySelector("svg")!;
    // Custom icons carry stroke-width on the <circle>; Lucide carries it on the <svg>.
    const customRatio = strokeRatio(customSvg, customSvg.querySelector("circle"));

    const { container: lucide } = render(<CheckCircle2 />);
    const lucideSvg = lucide.querySelector("svg")!;
    const lucideRatio = strokeRatio(lucideSvg, lucideSvg);

    expect(customRatio).toBeCloseTo(lucideRatio, 3);
  });

  // InteractingCircle and ExitedCircle draw inner detail lines that are
  // deliberately thinner than the outer ring (hand-tuned to 0.75x and 0.9x of the
  // ring stroke). The #9705 fix scaled the ring AND the inner lines by the same
  // factor, so this proportion must be preserved. Asserting the inner/outer ratio
  // (not the literal stroke-width) catches a regression where the ring is rescaled
  // but the inner lines are forgotten, or vice versa.
  it.each([
    ["InteractingCircle", InteractingCircle, 0.75],
    ["ExitedCircle", ExitedCircle, 0.9],
  ])("%s keeps its inner detail strokes proportional to the ring", (_name, Component, ratio) => {
    const { container } = render(<Component />);
    const ringStroke = parseFloat(container.querySelector("circle")!.getAttribute("stroke-width")!);
    const lines = container.querySelectorAll("line");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const lineStroke = parseFloat(line.getAttribute("stroke-width")!);
      expect(lineStroke / ringStroke).toBeCloseTo(ratio, 2);
    }
  });

  it("re-exports SpinnerCircle through the barrel", () => {
    expect(SpinnerCircle).toBe(DirectSpinnerCircle);
    const { container } = render(<SpinnerCircle />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Brand icon a11y", () => {
  it.each([
    ["ClaudeIcon", ClaudeIcon],
    ["NpmIcon", NpmIcon],
    ["InterpreterIcon", InterpreterIcon],
    ["GooseIcon", GooseIcon],
    ["PythonIcon", PythonIcon],
    ["DockerIcon", DockerIcon],
  ])("%s defaults to aria-hidden and forwards arbitrary SVG props", (_name, Icon) => {
    const { container } = render(<Icon className="size-4" data-testid="icon-under-test" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("size-4");
    expect(svg?.getAttribute("data-testid")).toBe("icon-under-test");
  });

  it.each([
    ["ClaudeIcon", ClaudeIcon],
    ["InterpreterIcon", InterpreterIcon],
    ["GooseIcon", GooseIcon],
  ])("%s allows overriding aria-hidden when used as the sole label", (_name, Icon) => {
    const { container } = render(
      <Icon aria-hidden={undefined} role="img" aria-label="Brand mark" />
    );
    const svg = container.querySelector("svg");
    expect(svg?.hasAttribute("aria-hidden")).toBe(false);
    expect(svg?.getAttribute("aria-label")).toBe("Brand mark");
  });

  it("ClaudeIcon paints from currentColor so the badge ink reaches it", () => {
    // Brand marks stopped taking a fill in #11895: the glyph is knocked out of
    // the badge tile, and inheriting is what lets `BrandMark` choose an ink that
    // clears contrast without recolouring the identity.
    const { container } = render(<ClaudeIcon />);
    const path = container.querySelector("svg path");
    expect(path?.getAttribute("fill")).toBe("currentColor");
  });

  it("AiderIcon preserves fill='none' (stroke-only icon)", () => {
    const { container } = render(<AiderIcon />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("none");
  });
});
