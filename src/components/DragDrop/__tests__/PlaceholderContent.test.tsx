// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { BUILT_IN_PANEL_KINDS } from "@shared/config/panelKindRegistry";
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

/** The illustration with every per-kind tint stripped, so only its shape remains. */
function shape(kind: string): string {
  const { container } = render(<PlaceholderContent kind={kind} />);
  return container.innerHTML.replace(/ style="[^"]*"/g, "");
}

/**
 * The header carries the identity; the illustration is what makes the ghost
 * read as *this* kind of panel at a glance. Eight kinds used to collapse into
 * the same three bars, so the rule is: no two kinds share a composition, and
 * a kind the registry has never heard of is not dressed up as a terminal.
 */
describe("PlaceholderContent kind compositions", () => {
  it("gives every built-in kind its own composition", () => {
    const shapes = new Map(BUILT_IN_PANEL_KINDS.map((kind) => [kind, shape(kind)]));
    for (const [kind, markup] of shapes) {
      for (const [other, otherMarkup] of shapes) {
        if (kind !== other) expect(markup, `${kind} vs ${other}`).not.toBe(otherMarkup);
      }
    }
  });

  it("does not impersonate a built-in kind for an unknown one", () => {
    const unknown = shape("sticky-notes");
    for (const kind of BUILT_IN_PANEL_KINDS) {
      expect(unknown, `unknown vs ${kind}`).not.toBe(shape(kind));
    }
  });

  it("keeps illustration geometry on the class scale, not in inline styles", () => {
    for (const kind of [...BUILT_IN_PANEL_KINDS, "sticky-notes"]) {
      for (const compact of [false, true]) {
        const { container } = render(<PlaceholderContent kind={kind} compact={compact} />);
        for (const el of container.querySelectorAll<HTMLElement>("[style]")) {
          const props = (el.getAttribute("style") ?? "")
            .split(";")
            .map((d) => d.split(":")[0]!.trim())
            .filter(Boolean);
          for (const prop of props) {
            // Bar widths are content (how long the line is), tints are the kind colour.
            expect(prop === "width" || prop.startsWith("--ph-"), `${kind}: ${prop}`).toBe(true);
          }
        }
      }
    }
  });
});
