// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import "@/components/PluginKit/PluginKit";
import { renderIconSource, resolvePluginKitIcon } from "@/components/PluginKit/PluginKitIcons";

beforeAll(async () => {
  await primeRadix();
  render(createElement(kit.Spinner));
  await vi.waitFor(
    () => {
      if (!document.querySelector(".animate-spin")) throw new Error("kit not loaded");
    },
    { timeout: 5_000 }
  );
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ownSvg = () =>
  createElement(
    "svg",
    { "data-own-icon": "", viewBox: "0 0 16 16" },
    createElement("circle", { cx: 8, cy: 8, r: 6 })
  );

function glyphIn(container: Element): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("no glyph");
  return svg;
}

describe("kit icons", () => {
  it("draws a curated name in the first commit", () => {
    const { container } = render(createElement(kit.Icon, { name: "wallet", size: 20 }));
    const svg = glyphIn(container);
    expect(svg.hasAttribute("data-kit-icon-loading")).toBe(false);
    expect(svg.childElementCount).toBeGreaterThan(0);
  });

  it("loads any other Lucide name, holding an empty frame of the same box until it lands", async () => {
    const { container } = render(
      createElement(kit.Icon, { name: "chart-candlestick", size: 20, className: "text-x" })
    );
    const frame = glyphIn(container);
    expect(frame.hasAttribute("data-kit-icon-loading")).toBe(true);
    expect(frame.childElementCount).toBe(0);
    const box = ["width", "height", "viewBox", "class"].map((name) => frame.getAttribute(name));

    await waitFor(() => {
      if (glyphIn(container).hasAttribute("data-kit-icon-loading")) throw new Error("loading");
    });
    const glyph = glyphIn(container);
    expect(glyph.childElementCount).toBeGreaterThan(0);
    expect(glyph.getAttribute("width")).toBe(box[0]);
    expect(glyph.getAttribute("height")).toBe(box[1]);
    expect(glyph.getAttribute("viewBox")).toBe(box[2]);
    // The frame wears every class the glyph does, so nothing restyles on arrival.
    for (const name of box[3]!.split(" ")) expect(glyph.classList.contains(name)).toBe(true);
  });

  it("keeps a loaded name, so the next use draws it at once", async () => {
    const first = render(createElement(kit.Icon, { name: "sailboat" }));
    await waitFor(() => {
      if (glyphIn(first.container).hasAttribute("data-kit-icon-loading"))
        throw new Error("loading");
    });
    cleanup();
    const { container } = render(createElement(kit.Icon, { name: "sailboat" }));
    expect(glyphIn(container).hasAttribute("data-kit-icon-loading")).toBe(false);
    expect(glyphIn(container).childElementCount).toBeGreaterThan(0);
  });

  it("draws nothing for a name Lucide does not have, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(createElement(kit.Icon, { name: "acme-ledger-glyph" }));
    await waitFor(() => {
      if (container.querySelector("svg")) throw new Error("still framed");
    });
    const notes = () =>
      warn.mock.calls.filter((call) => String(call[0]).includes("acme-ledger-glyph"));
    expect(notes()).toHaveLength(1);
    cleanup();
    // The map is in hand now: the same name is refused without a frame.
    const again = render(createElement(kit.Icon, { name: "acme-ledger-glyph" }));
    expect(again.container.querySelector("svg")).toBeNull();
    expect(notes()).toHaveLength(1);
  });

  it("refuses a string that cannot be a Lucide name in the same call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePluginKitIcon("Not An Icon")).toBeUndefined();
    expect(resolvePluginKitIcon("toString")).toBeUndefined();
    expect(warn.mock.calls.some((call) => String(call[0]).includes("Not An Icon"))).toBe(true);
  });

  it("boxes a plugin's own element to the slot's size, and leaves it as given without one", () => {
    const sized = render(createElement("div", null, renderIconSource(ownSvg(), "h-3.5 w-3.5")));
    const box = sized.container.querySelector("[data-own-icon]")?.parentElement;
    expect(box?.tagName).toBe("SPAN");
    expect(box?.classList.contains("h-3.5")).toBe(true);
    expect(box?.getAttribute("aria-hidden")).toBe("true");
    cleanup();
    const bare = render(createElement("div", null, renderIconSource(ownSvg())));
    expect(bare.container.firstElementChild?.firstElementChild?.hasAttribute("data-own-icon")).toBe(
      true
    );
  });

  it("hands a host glyph slot an element, sized, with its root attributes, updated in place", () => {
    const spin = (marker: string) =>
      createElement(kit.SpinningIcon, {
        icon: createElement("svg", { "data-own-icon": marker, viewBox: "0 0 16 16" }),
        active: false,
        size: 12,
        "data-testid": "spin",
      });
    const { rerender } = render(spin("first"));
    const box = screen.getByTestId("spin");
    expect(box.getAttribute("style")).toContain("width: 12px");
    expect(box.querySelector("[data-own-icon]")?.getAttribute("data-own-icon")).toBe("first");
    // A new element each render is the usual JSX: the icon updates, never remounts.
    rerender(spin("second"));
    expect(screen.getByTestId("spin")).toBe(box);
    expect(box.querySelector("[data-own-icon]")?.getAttribute("data-own-icon")).toBe("second");
  });

  it("takes any icon source in SpinningIcon and Callout", async () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.SpinningIcon, {
          icon: "hand-coins",
          active: false,
          "data-testid": "spin",
        }),
        createElement(
          kit.Callout,
          { severity: "neutral", icon: ownSvg(), title: "Ledger" },
          "Balanced"
        )
      )
    );
    expect(document.querySelector("[data-own-icon]")).not.toBeNull();
    await waitFor(() => {
      const glyph = screen.getByTestId("spin");
      if (glyph.hasAttribute("data-kit-icon-loading")) throw new Error("loading");
    });
    expect(screen.getByTestId("spin").childElementCount).toBeGreaterThan(0);
  });

  it("draws an element or any Lucide name on a DropdownMenu row", async () => {
    render(
      createElement(kit.DropdownMenu, {
        open: true,
        trigger: createElement(kit.Button, { children: "Ledger" }),
        items: [
          { label: "Export", icon: ownSvg(), onSelect: () => {} },
          { label: "Reconcile", icon: "vault", onSelect: () => {} },
          {
            type: "submenu",
            label: "More",
            icon: "bitcoin",
            items: [{ label: "Archive", onSelect: () => {} }],
          },
        ],
      })
    );
    const rows = await screen.findAllByRole("menuitem");
    expect(rows[0]!.querySelector("[data-menu-icon] [data-own-icon]")).not.toBeNull();
    await waitFor(() => {
      for (const row of rows.slice(1)) {
        const glyph = row.querySelector("[data-menu-icon] svg");
        if (!glyph || glyph.hasAttribute("data-kit-icon-loading") || glyph.childElementCount === 0)
          throw new Error("loading");
      }
    });
  });
});
