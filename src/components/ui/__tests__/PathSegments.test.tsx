/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PathSegments } from "../PathSegments";

afterEach(cleanup);

function segmentsOf(path: string): Element[] {
  const { container } = render(
    <p>
      <PathSegments path={path} />
    </p>
  );
  const host = container.firstElementChild;
  expect(host?.textContent).toBe(path);
  return Array.from(host?.children ?? []);
}

describe("PathSegments", () => {
  it.each([
    "/Users/you/Library/Mobile Documents/helios-dashboard-realtime-console",
    "C:\\Users\\you\\my project\\helios-web",
    ".daintree/plugins/my-plugin",
    "/trailing/slash/",
  ])("gives %s one unbreakable box per folder, split only after separators", (path) => {
    const segments = segmentsOf(path);
    expect(segments.length).toBeGreaterThan(1);
    segments.forEach((segment, i) => {
      // Atomic: the line can end between boxes, never at a hyphen or space inside one.
      expect(segment.classList.contains("inline-block")).toBe(true);
      const text = segment.textContent ?? "";
      const body = text.slice(0, -1);
      expect(/[/\\]/.test(body)).toBe(false);
      if (i < segments.length - 1) expect(/[/\\]$/.test(text)).toBe(true);
    });
  });

  it("keeps a single-segment name whole", () => {
    expect(segmentsOf("helios-dashboard")).toHaveLength(1);
  });
});
