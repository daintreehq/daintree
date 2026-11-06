// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HTML_PREVIEW_PARTITION } from "@shared/utils/partitionUtils";
import { HtmlViewer } from "../HtmlViewer";

describe("HtmlViewer", () => {
  it("renders the page as a webview guest in the preview partition, never an app iframe", () => {
    const { getByTestId, container } = render(
      <HtmlViewer
        previewUrl="daintree-html://tok/index.html"
        reloadNonce={0}
        title="report.html"
        onShowSource={vi.fn()}
      />
    );
    const frame = getByTestId("html-preview-frame");
    // An iframe shares the app's WebContents, where Chromium can't block WebRTC
    // (#15793); main attaches this src only in the preview partition.
    expect(frame.tagName).toBe("WEBVIEW");
    expect(container.querySelector("iframe")).toBeNull();
    expect(frame.getAttribute("partition")).toBe(HTML_PREVIEW_PARTITION);
    expect(frame.getAttribute("partition")?.startsWith("persist:")).toBe(false);
    expect(frame.getAttribute("allowpopups")).toBeNull();
    expect(frame.getAttribute("title")).toBe("report.html");
  });

  it("remounts the guest when the file changes, not when only the nonce does", () => {
    const { getByTestId, rerender } = render(
      <HtmlViewer
        previewUrl="daintree-html://tok/a.html"
        reloadNonce={1}
        title="a"
        onShowSource={vi.fn()}
      />
    );
    const first = getByTestId("html-preview-frame");

    rerender(
      <HtmlViewer
        previewUrl="daintree-html://tok/a.html"
        reloadNonce={2}
        title="a"
        onShowSource={vi.fn()}
      />
    );
    expect(getByTestId("html-preview-frame")).toBe(first);

    rerender(
      <HtmlViewer
        previewUrl="daintree-html://tok/b.html"
        reloadNonce={2}
        title="b"
        onShowSource={vi.fn()}
      />
    );
    expect(getByTestId("html-preview-frame")).not.toBe(first);
  });

  it("appends a cache-busting nonce query so a rewritten file re-navigates", () => {
    const { getByTestId, rerender } = render(
      <HtmlViewer
        previewUrl="daintree-html://tok/index.html"
        reloadNonce={1}
        title="r"
        onShowSource={vi.fn()}
      />
    );
    const frame = () => getByTestId("html-preview-frame");
    expect(frame().getAttribute("src")).toBe("daintree-html://tok/index.html?v=1");

    rerender(
      <HtmlViewer
        previewUrl="daintree-html://tok/index.html"
        reloadNonce={2}
        title="r"
        onShowSource={vi.fn()}
      />
    );
    expect(frame().getAttribute("src")).toBe("daintree-html://tok/index.html?v=2");
  });

  it("uses & when the preview URL already has a query", () => {
    const { getByTestId } = render(
      <HtmlViewer
        previewUrl="daintree-html://tok/index.html?a=1"
        reloadNonce={3}
        title="r"
        onShowSource={vi.fn()}
      />
    );
    const frame = getByTestId("html-preview-frame");
    expect(frame.getAttribute("src")).toBe("daintree-html://tok/index.html?a=1&v=3");
  });

  it("shows a fallback instead of a blank frame when there is no preview URL", () => {
    const { queryByTestId, getByText } = render(
      <HtmlViewer previewUrl={null} reloadNonce={0} title="r" onShowSource={vi.fn()} />
    );
    expect(queryByTestId("html-preview-frame")).toBeNull();
    expect(getByText("Can't preview this file here")).toBeTruthy();
  });
});
