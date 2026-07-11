// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PlaceholderContent } from "../PlaceholderContent";

/**
 * Regression coverage for #11055: the dock drag placeholder grew taller than the
 * dock chips because BrowserPlaceholder / DevPreviewPlaceholder rendered their
 * padded content body even in compact mode — the only mode the dock uses. The
 * fix drops that body in compact so the ghost fits within --dock-item-height.
 *
 * jsdom has no layout engine, so instead of measuring pixels we assert the
 * conditional structure that drives the height: the tall body is marked with
 * [data-placeholder-body] and must be absent in compact mode.
 */
describe("PlaceholderContent compact body gating (#11055)", () => {
  it("renders the browser content body only in full mode, not compact", () => {
    const full = render(<PlaceholderContent kind="browser" />);
    expect(full.container.querySelectorAll("[data-placeholder-body]")).toHaveLength(1);

    const compact = render(<PlaceholderContent kind="browser" compact />);
    expect(compact.container.querySelectorAll("[data-placeholder-body]")).toHaveLength(0);
  });

  it("renders the dev-preview split body only in full mode, not compact", () => {
    const full = render(<PlaceholderContent kind="dev-preview" />);
    expect(full.container.querySelectorAll("[data-placeholder-body]")).toHaveLength(1);

    const compact = render(<PlaceholderContent kind="dev-preview" compact />);
    expect(compact.container.querySelectorAll("[data-placeholder-body]")).toHaveLength(0);
  });

  it("keeps compact browser/dev-preview placeholders non-empty (address bar survives)", () => {
    // Dropping the body must not blank the ghost — the address-bar row still
    // renders so the drop target stays visually distinct. Assert the placeholder
    // root actually has rendered art, not just that some element exists.
    const browser = render(<PlaceholderContent kind="browser" compact />);
    expect(browser.container.firstElementChild?.children.length ?? 0).toBeGreaterThan(0);

    const devPreview = render(<PlaceholderContent kind="dev-preview" compact />);
    expect(devPreview.container.firstElementChild?.children.length ?? 0).toBeGreaterThan(0);
  });

  it("does not introduce a content body for kinds that never had one (terminal)", () => {
    const full = render(<PlaceholderContent kind="terminal" />);
    const compact = render(<PlaceholderContent kind="terminal" compact />);
    expect(full.container.querySelectorAll("[data-placeholder-body]")).toHaveLength(0);
    expect(compact.container.querySelectorAll("[data-placeholder-body]")).toHaveLength(0);
  });
});
