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
import { readFileSync } from "node:fs";
import path from "node:path";
import { CheckCircle2 } from "lucide-react";
import { glyphBox } from "./glyphBox";
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
    const glyph = glyphBox(container);
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
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
    const glyph = glyphBox(container);
    expect(glyph?.hasAttribute("aria-hidden")).toBe(false);
    expect(glyph?.getAttribute("role")).toBe("img");
    expect(glyph?.getAttribute("aria-label")).toBe("Working");
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

  // SpinnerCircle is drawn in CSS, so its geometry lives in index.css rather than
  // in svg attributes. These hold it to the svg it replaced (and that its sibling
  // circles still are): a 16-unit box, r=6, stroke 1.333, a 270deg arc whose gap
  // runs from 3:00 to 6:00, round caps. Derived from those numbers, not restated,
  // and read from live declarations: comments are stripped and whitespace is
  // normalised, so a commented-out mask fails and a prettier reflow does not.
  describe("SpinnerCircle CSS geometry", () => {
    const BOX = 16;
    const R = 6;
    const STROKE = 1.333;
    const pct = (units: number, of: number) => (units / of) * 100;

    const css = readFileSync(path.resolve(__dirname, "../../../index.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      ""
    );

    /** The body between a `{` and its matching `}`. */
    const blockAt = (source: string, open: number): string => {
      let depth = 0;
      for (let i = open; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
      }
      throw new Error("unbalanced block");
    };
    const declarationsOf = (body: string): [string, string][] =>
      body
        .split(";")
        .map((d) => d.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]);
    /** Split on the commas that separate layers, not the ones inside functions. */
    const layersOf = (value: string): string[] => {
      const layers: string[] = [];
      let depth = 0;
      let current = "";
      for (const ch of value) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          layers.push(current.trim());
          current = "";
        } else current += ch;
      }
      return [...layers, current.trim()];
    };

    const ruleStart = css.search(/(^|\n)\.spinner-circle \{/);
    const declarations = declarationsOf(blockAt(css, css.indexOf("{", ruleStart)));
    const valueOf = (prop: string) => declarations.find(([name]) => name === prop)?.[1] ?? "";
    const [capA, capB, arc, ring] = layersOf(valueOf("mask"));

    it("is the rule the rendered glyph actually uses", () => {
      const { container } = render(<DirectSpinnerCircle className="w-3 h-3" />);
      const glyph = glyphBox(container)!;
      expect(glyph.tagName).toBe("SPAN");
      expect(glyph.matches(".spinner-circle")).toBe(true);
      // Drawn by the stylesheet alone: no svg and no markup of its own.
      expect(glyph.childElementCount).toBe(0);
      expect(container.querySelector("svg")).toBeNull();
    });

    it("draws with four live mask layers: two caps, the arc, the ring", () => {
      expect(ruleStart).toBeGreaterThanOrEqual(0);
      expect(layersOf(valueOf("mask"))).toHaveLength(4);
      expect(capA).toMatch(/^radial-gradient\(ellipse /);
      expect(capB).toMatch(/^radial-gradient\(ellipse /);
      expect(arc).toMatch(/^conic-gradient\(/);
      expect(ring).toMatch(/^radial-gradient\( ?closest-side,/);
    });

    it("unions the caps with the arc-inside-the-ring, after the shorthand", () => {
      expect(valueOf("mask-composite")).toBe("add, add, intersect, add");
      // `mask` resets mask-composite, so the longhand has to come second.
      const order = declarations.map(([name]) => name);
      expect(order.indexOf("mask-composite")).toBeGreaterThan(order.indexOf("mask"));
    });

    it("paints the tone once so a translucent tone stays even along the arc", () => {
      expect(valueOf("background")).toBe("currentColor");
    });

    const ringStops = () => [...ring!.matchAll(/#000 calc\( ?([\d.]+)%/g)].map((m) => Number(m[1]));

    it("cuts the ring at the svg stroke's inner and outer radius", () => {
      const [inner, outer] = ringStops();
      // closest-side stops are percentages of the half-box.
      expect(inner).toBeCloseTo(pct(R - STROKE / 2, BOX / 2), 1);
      expect(outer).toBeCloseTo(pct(R + STROKE / 2, BOX / 2), 1);
    });

    it("is the same line weight as a Lucide icon at any size", () => {
      const [inner, outer] = ringStops();
      const { container: lucide } = render(<CheckCircle2 />);
      const lucideSvg = lucide.querySelector("svg")!;
      expect((outer! - inner!) / 100 / 2).toBeCloseTo(strokeRatio(lucideSvg, lucideSvg), 3);
    });

    it("sweeps 270deg and leaves the gap from 3:00 to 6:00", () => {
      const conic = arc!.match(
        /^conic-gradient\( ?from (\d+)deg, #000 (\d+)deg, transparent 0 ?\)$/
      );
      expect(conic).not.toBeNull();
      const [from, sweep] = [Number(conic![1]), Number(conic![2])];
      expect(sweep).toBe(270);
      // Colour runs from `from` for `sweep`; what is left must be 90deg..180deg.
      expect(from).toBe(180);
      expect((from + sweep) % 360).toBe(90);
    });

    it("rounds both arc ends with caps of half the stroke, centred on the ring", () => {
      const caps = [capA!, capB!].map((layer) => {
        const m = layer.match(/ellipse ([\d.]+)% ([\d.]+)% at ([\d.]+)% ([\d.]+)%/);
        expect(m).not.toBeNull();
        return m!.slice(1).map(Number);
      });
      const centre = 50 + pct(R, BOX);
      for (const [rx, ry] of caps) {
        expect(rx).toBeCloseTo(pct(STROKE / 2, BOX), 1);
        expect(ry).toBe(rx);
      }
      // One cap at 6:00 (x centred, y out), one at 3:00 (x out, y centred).
      expect(caps.map(([, , x, y]) => [x, y])).toEqual(
        expect.arrayContaining([
          [50, centre],
          [centre, 50],
        ])
      );
    });

    it("survives forced colours, paired with the surface it sits on", () => {
      const forcedBlocks = [...css.matchAll(/@media \(forced-colors: active\) \{/g)].map((m) =>
        blockAt(css, m.index! + m[0].length - 1)
      );
      const ruleIn = (selector: RegExp) => {
        for (const block of forcedBlocks) {
          const at = block.search(selector);
          if (at >= 0)
            return Object.fromEntries(declarationsOf(blockAt(block, block.indexOf("{", at))));
        }
        return undefined;
      };
      // A glyph that is only a background is erased by the forced canvas colour.
      expect(ruleIn(/(^|\n)\s*\.spinner-circle \{/)).toEqual({
        "forced-color-adjust": "none",
        background: "CanvasText",
      });
      // Inside a control the surface is ButtonFace, whose guaranteed pair is ButtonText.
      expect(ruleIn(/button \.spinner-circle,/)).toEqual({ background: "ButtonText" });
    });
  });

  it.each([
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
    expect(glyphBox(container)?.getAttribute("aria-hidden")).toBe("true");
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

  it("ClaudeIcon forwards SVG props and keeps its paint on currentColor", () => {
    // Nothing hands a colour to a glyph any more — `BrandMark` publishes the ink
    // as custom properties and the paint inherits it.
    const { container } = render(<ClaudeIcon style={{ opacity: 0.5 }} />);
    const svg = container.querySelector("svg");
    expect(svg?.style.opacity).toBe("0.5");
    expect(container.querySelector("svg path")?.getAttribute("fill")).toBe("currentColor");
  });

  it("AiderIcon preserves fill='none' (stroke-only icon)", () => {
    const { container } = render(<AiderIcon />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("none");
  });
});
