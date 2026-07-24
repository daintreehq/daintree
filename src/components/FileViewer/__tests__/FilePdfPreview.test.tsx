// @vitest-environment jsdom
/**
 * Shared inline PDF preview (#11427).
 *
 * jsdom has no PDFium, so these tests pin the frame contract the real viewer
 * depends on — each assertion here stands in for a failure mode verified
 * against Electron 42 / Chromium 148:
 *   - a missing `credentialless` attribute => ERR_BLOCKED_BY_RESPONSE, blank frame
 *   - a `sandbox` attribute                => ERR_BLOCKED_BY_CLIENT, blank frame
 *   - a daintree-file:// src              => blocked by the app CSP's frame-src
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { FilePdfPreview } from "../FilePdfPreview";

afterEach(cleanup);

function renderPreview(props: Partial<React.ComponentProps<typeof FilePdfPreview>> = {}) {
  const { container } = render(
    <FilePdfPreview filePath="/repo/spec.pdf" rootPath="/repo" label="spec.pdf" {...props} />
  );
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("expected an iframe");
  return frame;
}

describe("FilePdfPreview", () => {
  it("points the frame at the PDF-only scheme with the file and root as params", () => {
    const url = new URL(renderPreview().getAttribute("src") ?? "");
    expect(url.protocol).toBe("daintree-pdf:");
    expect(url.searchParams.get("path")).toBe("/repo/spec.pdf");
    expect(url.searchParams.get("root")).toBe("/repo");
  });

  it("marks the frame credentialless so a COEP shell can embed a COEP-less document", () => {
    // Presence is what matters, and React omits unknown attributes given a
    // boolean value — so assert the attribute actually reached the DOM rather
    // than trusting the prop.
    expect(renderPreview().hasAttribute("credentialless")).toBe(true);
  });

  it("never sandboxes the frame", () => {
    // Unlike the daintree-html:// preview, a sandbox attribute stops PDFium
    // from installing its viewer frame at all.
    expect(renderPreview().hasAttribute("sandbox")).toBe(false);
  });

  it("names the frame with the file label and withholds the referrer", () => {
    const frame = renderPreview({ label: "datasheet.pdf" });
    expect(frame.getAttribute("title")).toBe("datasheet.pdf");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("re-navigates to a new URL when the reload key changes", () => {
    const first = renderPreview({ reloadKey: 1 }).getAttribute("src");
    cleanup();
    const second = renderPreview({ reloadKey: 2 }).getAttribute("src");
    expect(second).not.toBe(first);
  });

  it("keeps the same URL across renders when the reload key does not change", () => {
    // The protocol serves no-store, so a stable URL is what preserves the
    // reader's page and zoom across an unrelated re-render.
    const first = renderPreview({ reloadKey: 7 }).getAttribute("src");
    cleanup();
    const second = renderPreview({ reloadKey: 7 }).getAttribute("src");
    expect(second).toBe(first);
  });

  it("treats a zero reload key as a real value rather than an absent one", () => {
    const zero = renderPreview({ reloadKey: 0 }).getAttribute("src");
    cleanup();
    const absent = renderPreview().getAttribute("src");
    expect(zero).not.toBe(absent);
  });
});
