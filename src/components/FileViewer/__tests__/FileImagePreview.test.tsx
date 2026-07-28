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
import { buildDaintreeFileUrl } from "../filePreviewKinds";

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

/**
 * The protocol URL is a pure function of path and root, so a rewritten image is
 * never refetched without a changing token (#11451). `Cache-Control: no-store`
 * on the response only governs a request that actually happens.
 */
describe("FileImagePreview cache busting", () => {
  function renderRaster(cacheBust?: string) {
    return render(
      <FileImagePreview
        filePath="/repo/assets/logo.png"
        rootPath="/repo"
        alt="logo.png"
        sanitizedSvg={null}
        cacheBust={cacheBust}
      />
    );
  }

  function rawSrc(container: HTMLElement): string {
    const src = container.querySelector("img")?.getAttribute("src");
    if (!src) throw new Error("img not rendered");
    return src;
  }

  function parseSrc(container: HTMLElement): URL {
    return new URL(rawSrc(container));
  }

  /** The value of the one parameter the token adds, whatever it is named. */
  function addedParamValue(busted: URL, canonical: URL): string | undefined {
    const extra = [...busted.searchParams].filter(([key]) => !canonical.searchParams.has(key));
    expect(extra).toHaveLength(1);
    return extra[0]?.[1];
  }

  it("leaves the URL untouched when no token is supplied", () => {
    // Whole-URL equality, so a phantom `&…=undefined` fails no matter its name.
    const { container } = renderRaster();

    expect(rawSrc(container)).toBe(buildDaintreeFileUrl("/repo/assets/logo.png", "/repo"));
  });

  it("carries an opaque token through without disturbing path or root", () => {
    // Reserved characters throughout: unencoded, this would inject extra
    // parameters and corrupt the path/root the protocol resolves against.
    const token = "7 &root=/etc/?#";
    const canonical = parseSrc(renderRaster().container);
    cleanup();

    const busted = parseSrc(renderRaster(token).container);

    expect(addedParamValue(busted, canonical)).toBe(token);
    expect(busted.searchParams.get("path")).toBe(canonical.searchParams.get("path"));
    expect(busted.searchParams.get("root")).toBe(canonical.searchParams.get("root"));
  });

  it("swaps the src in place when the token changes, without remounting", () => {
    // Remounting would drop the painted frame and flash empty mid-refresh; the
    // point is to change the URL while the element survives.
    const { container, rerender } = renderRaster("1");
    const img = container.querySelector("img");
    const before = rawSrc(container);

    rerender(
      <FileImagePreview
        filePath="/repo/assets/logo.png"
        rootPath="/repo"
        alt="logo.png"
        sanitizedSvg={null}
        cacheBust="2"
      />
    );

    expect(rawSrc(container)).not.toBe(before);
    expect(container.querySelector("img")).toBe(img);
  });

  it("ignores the token when SVG markup is inlined", () => {
    // Inlined SVG has no URL to bust — it is re-read and re-sanitized upstream.
    const { container } = render(
      <FileImagePreview
        filePath="/repo/assets/icon.svg"
        rootPath="/repo"
        alt="icon.svg"
        sanitizedSvg={`<svg xmlns="${SVG_NS}"><rect /></svg>`}
        cacheBust="9"
      />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg rect")).not.toBeNull();
  });
});
