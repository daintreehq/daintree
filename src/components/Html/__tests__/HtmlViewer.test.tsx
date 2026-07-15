// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HtmlViewer } from "../HtmlViewer";

describe("HtmlViewer", () => {
  it("renders a sandboxed iframe with allow-scripts and no allow-same-origin", () => {
    const { getByTestId } = render(
      <HtmlViewer previewUrl="daintree-html://tok/index.html" reloadNonce={0} title="report.html" />
    );
    const frame = getByTestId("html-preview-frame") as HTMLIFrameElement;
    // Exactly allow-scripts — same-origin would let the frame escape its opaque origin.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("report.html");
  });

  it("appends a cache-busting nonce query so a rewritten file re-navigates", () => {
    const { getByTestId, rerender } = render(
      <HtmlViewer previewUrl="daintree-html://tok/index.html" reloadNonce={1} title="r" />
    );
    const frame = () => getByTestId("html-preview-frame") as HTMLIFrameElement;
    expect(frame().getAttribute("src")).toBe("daintree-html://tok/index.html?v=1");

    rerender(<HtmlViewer previewUrl="daintree-html://tok/index.html" reloadNonce={2} title="r" />);
    expect(frame().getAttribute("src")).toBe("daintree-html://tok/index.html?v=2");
  });

  it("uses & when the preview URL already has a query", () => {
    const { getByTestId } = render(
      <HtmlViewer previewUrl="daintree-html://tok/index.html?a=1" reloadNonce={3} title="r" />
    );
    const frame = getByTestId("html-preview-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("daintree-html://tok/index.html?a=1&v=3");
  });

  it("shows a fallback instead of a blank frame when there is no preview URL", () => {
    const { queryByTestId, getByText } = render(
      <HtmlViewer previewUrl={null} reloadNonce={0} title="r" />
    );
    expect(queryByTestId("html-preview-frame")).toBeNull();
    expect(getByText("Can't render this file")).toBeTruthy();
  });
});
