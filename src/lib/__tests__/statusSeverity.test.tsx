// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SEVERITY_VISUAL, SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";

const LEVELS: StatusSeverity[] = ["success", "error", "warning", "info"];

describe("SEVERITY_VISUAL", () => {
  it("gives each level a shape of its own", () => {
    // Shape is what survives forced-colors; if two levels shared a glyph they
    // would be indistinguishable exactly where the palette has already gone.
    const icons = LEVELS.map((level) => SEVERITY_VISUAL[level].Icon);
    expect(new Set(icons).size).toBe(LEVELS.length);
  });

  it("tones every level with a text colour, so it strokes in currentColor", () => {
    for (const level of LEVELS) {
      expect(SEVERITY_VISUAL[level].toneClass.startsWith("text-")).toBe(true);
    }
  });
});

describe("SeverityMark", () => {
  it("names the outcome for assistive tech and on hover", () => {
    const { container } = render(<SeverityMark severity="error" label="Unauthorized" />);
    const mark = container.firstElementChild!;
    expect(mark.getAttribute("role")).toBe("img");
    expect(mark.getAttribute("aria-label")).toBe("Unauthorized");
    // The dot this replaces carried a `title`; losing it would drop the hover
    // affordance on rows whose visible text is only an id.
    expect(mark.getAttribute("title")).toBe("Unauthorized");
  });

  it("hides itself from assistive tech when decorative, keeping the hover title", () => {
    const { container } = render(<SeverityMark severity="info" label="Deduplicated" decorative />);
    const mark = container.firstElementChild!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("aria-label")).toBeNull();
    expect(mark.getAttribute("title")).toBe("Deduplicated");
  });

  it("renders a different glyph per level", () => {
    const shapes = LEVELS.map((level) => {
      const { container } = render(<SeverityMark severity={level} label={level} />);
      return container.querySelector("svg")!.innerHTML;
    });
    expect(new Set(shapes).size).toBe(LEVELS.length);
  });
});
