// @vitest-environment jsdom
/**
 * SVG inlining for the shared file preview (#11239).
 *
 * `sanitizeSvg` documents that its output must not be embedded through an HTML
 * reparse, so this component inserts via `DOMParser`. That parser is
 * namespace-strict where `innerHTML` was not, which is the regression these
 * tests pin: a real-world SVG without an `xmlns` must still render.
 */
import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { FileImagePreview } from "../FileImagePreview";

afterEach(cleanup);

const SVG_NS = "http://www.w3.org/2000/svg";

function renderSvg(markup: string) {
  const { container } = render(
    <FileImagePreview
      filePath="/repo/icon.svg"
      rootPath="/repo"
      alt="icon.svg"
      sanitizedSvg={markup}
    />
  );
  return container.querySelector("svg");
}

describe("FileImagePreview SVG inlining", () => {
  it("renders an SVG that declares its namespace", () => {
    const svg = renderSvg(`<svg xmlns="${SVG_NS}" viewBox="0 0 10 10"><rect /></svg>`);

    expect(svg).not.toBeNull();
    expect(svg?.namespaceURI).toBe(SVG_NS);
    expect(svg?.querySelector("rect")).not.toBeNull();
  });

  it("renders an SVG missing its namespace declaration", () => {
    // Namespace-strict parsing would yield a null-namespace element here, which
    // mounts without error and paints nothing — a silent blank preview.
    const svg = renderSvg('<svg viewBox="0 0 10 10"><circle /></svg>');

    expect(svg).not.toBeNull();
    expect(svg?.namespaceURI).toBe(SVG_NS);
    expect(svg?.querySelector("circle")).not.toBeNull();
  });

  it("renders nothing for markup that does not parse", () => {
    const svg = renderSvg("<svg><unclosed></svg>");

    expect(svg).toBeNull();
  });

  it("renders nothing when the root element is not an svg", () => {
    const svg = renderSvg(`<wrapper xmlns="${SVG_NS}"><svg /></wrapper>`);

    expect(svg).toBeNull();
  });

  it("falls back to an img when no SVG markup is supplied", () => {
    const { container } = render(
      <FileImagePreview
        filePath="/repo/logo.png"
        rootPath="/repo"
        alt="logo.png"
        sanitizedSvg={null}
      />
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("logo.png");
    expect(img?.getAttribute("src")).toContain("daintree-file://");
  });
});
