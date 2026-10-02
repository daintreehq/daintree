// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(cleanup);

// The untyped shape a JavaScript view can send: the adapters must degrade, never throw.
function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function element(found: Element | null | undefined): HTMLElement {
  if (!(found instanceof HTMLElement)) throw new Error("no element");
  return found;
}

function markup(tree: ReturnType<typeof createElement>): string {
  const { container } = render(tree);
  // useId values differ between renders; the structure is what is compared.
  const html = container.innerHTML.replace(/_r_[0-9a-z]+_/g, "id");
  cleanup();
  return html;
}

function classes(target: Element): string[] {
  return target.className.split(/\s+/).filter(Boolean);
}

describe("Card variants", () => {
  function cardWith(props: Record<string, unknown>, body: ReactNode = "Body") {
    render(untyped("Card", { title: "Balance", "data-testid": "card", ...props }, body));
    const card = screen.getByTestId("card");
    const heading = screen.getByRole("heading", { name: "Balance" });
    return { card, heading, header: element(heading.parentElement?.parentElement) };
  }

  it("lifts an elevated card onto the host's raised surface", () => {
    const { card } = cardWith({ variant: "elevated" });
    expect(card.getAttribute("data-variant")).toBe("elevated");
    expect(card.className).not.toMatch(/accent/);
  });

  it("draws a feature card raised, rounder, roomier and with a larger title", () => {
    const plain = cardWith({});
    const plainHeading = classes(plain.heading);
    const plainHeader = classes(plain.header);
    const plainRoot = classes(plain.card);
    cleanup();
    const feature = cardWith({ variant: "feature" });
    expect(feature.card.getAttribute("data-variant")).toBe("elevated");
    expect(classes(feature.heading)).not.toEqual(plainHeading);
    expect(classes(feature.header)).not.toEqual(plainHeader);
    expect(classes(feature.card).filter((name) => name.startsWith("rounded-"))).not.toEqual(
      plainRoot.filter((name) => name.startsWith("rounded-"))
    );
  });

  it("caps a feature card in a category colour, and only a feature card", () => {
    expect(cardWith({ variant: "feature", capColor: "teal" }).card.className).toContain(
      "category-teal"
    );
    cleanup();
    // `neutral` is the charts' slate, as it is everywhere a chart colour is drawn.
    expect(cardWith({ variant: "feature", capColor: "neutral" }).card.className).toContain(
      "category-slate"
    );
    cleanup();
    expect(cardWith({ variant: "elevated", capColor: "teal" }).card.className).not.toContain(
      "category-"
    );
    cleanup();
    expect(cardWith({ variant: "feature", capColor: "pink" }).card.className).not.toContain(
      "category-"
    );
    cleanup();
    expect(cardWith({ variant: "feature" }).card.className).not.toContain("category-");
  });

  it("keeps a clickable card outlined whatever its variant", () => {
    const plain = markup(untyped("Card", { title: "Open", onClick: () => {} }, "Body"));
    const feature = markup(
      untyped(
        "Card",
        { title: "Open", onClick: () => {}, variant: "feature", capColor: "blue" },
        "Body"
      )
    );
    expect(feature).toBe(plain);
  });

  it("ignores an unknown variant", () => {
    const { card } = cardWith({ variant: "tinted" });
    expect(card.getAttribute("data-variant")).toBe("default");
  });
});

describe("Card spacing", () => {
  function parts(props: Record<string, unknown>) {
    render(untyped("Card", { title: "Rates", "data-testid": "card", ...props }, "Body"));
    const card = screen.getByTestId("card");
    const header = element(
      screen.getByRole("heading", { name: "Rates" }).parentElement?.parentElement
    );
    return { card, header, body: element(header.nextElementSibling) };
  }

  it("sets a padded body apart from the header", () => {
    for (const padding of ["md", "sm"] as const) {
      const { header } = parts({ padding });
      expect(classes(header).some((name) => /^pb-/.test(name))).toBe(true);
      cleanup();
    }
  });

  it("keeps a padding-none body edge to edge under a fully padded header", () => {
    const { header, body } = parts({ padding: "none" });
    expect(classes(header).some((name) => /^pb-/.test(name))).toBe(true);
    expect(classes(body).some((name) => /^(p|px|py|pt|pb)-/.test(name))).toBe(false);
  });

  it("gives a small button's extra height back so it centres on the title line", () => {
    const actions = createElement(kit.Button, { size: "sm" }, "Edit");
    const boxFor = (variant: string) => {
      render(untyped("Card", { title: "Holdings", variant, actions }));
      let box = element(screen.getByRole("button", { name: "Edit" }));
      while (!classes(box).includes("shrink-0") || !box.className.includes("gap-2")) {
        box = element(box.parentElement);
      }
      const names = classes(box);
      cleanup();
      return names;
    };
    const standard = boxFor("default");
    expect(standard).toContain("items-center");
    expect(standard.some((name) => /^-my-/.test(name))).toBe(true);
    // A feature title's line is taller, so less is given back.
    const feature = boxFor("feature");
    expect(feature.some((name) => /^-my-/.test(name))).toBe(true);
    expect(feature.find((name) => /^-my-/.test(name))).not.toBe(
      standard.find((name) => /^-my-/.test(name))
    );
  });
});

describe("Card footerAlign", () => {
  function footerOf(footerAlign: unknown): HTMLElement {
    render(
      untyped(
        "Card",
        {
          footerAlign,
          "data-testid": "card",
          footer: [
            createElement("button", { type: "button", key: "a" }, "Reset"),
            createElement("button", { type: "button", key: "b" }, "Save"),
          ],
        },
        "Body"
      )
    );
    return element(screen.getByTestId("card").lastElementChild);
  }

  it("ends the footer by default and on an unknown value", () => {
    const fallback = footerOf(undefined).className;
    cleanup();
    expect(fallback).toContain("justify-end");
    expect(footerOf("end").className).toBe(fallback);
    cleanup();
    expect(footerOf("spread").className).toBe(fallback);
  });

  it("starts, splits or stretches the footer on request", () => {
    expect(footerOf("start").className).toContain("justify-start");
    cleanup();
    const between = footerOf("between").className;
    expect(between).toContain("justify-end");
    expect(between).toMatch(/first-child\]:mr-auto/);
    cleanup();
    expect(footerOf("stretch").className).toMatch(/\[&>\*\]:flex-1/);
  });
});

describe("Figure", () => {
  it("sets the label above, the figure with its unit, the twin and the caption", () => {
    const { container } = render(
      createElement(kit.Figure, {
        label: "Monthly budget",
        value: "€12,400",
        unit: "/mo",
        twin: "≈ $13,500/mo",
        caption: "After tax",
        "data-testid": "figure",
      })
    );
    const figure = screen.getByTestId("figure");
    expect(figure.textContent).toBe("Monthly budget€12,400/mo≈ $13,500/moAfter tax");
    expect(figure.getAttribute("data-size")).toBe("lg");
    const unit = element(screen.getByText("/mo"));
    const value = element(unit.parentElement);
    expect(value.className).toContain("tabular-nums");
    expect(value.className).toContain("lining-nums");
    expect(unit.className).toContain("font-normal");
    expect(unit.className).toContain("text-text-secondary");
    // The figure wraps; nothing in it is ever cut off.
    expect(container.innerHTML).not.toMatch(/truncate|line-clamp|uppercase|accent/);
  });

  it("draws each size at its own scale, and display steps with its width", () => {
    const valueClasses = new Set<string>();
    for (const size of ["display", "xl", "lg", "md"] as const) {
      render(createElement(kit.Figure, { value: "42", size, "data-testid": "figure" }));
      const figure = screen.getByTestId("figure");
      expect(figure.getAttribute("data-size")).toBe(size);
      valueClasses.add(element(screen.getByText("42")).className);
      if (size === "display") {
        expect(figure.className).toMatch(/@container/);
        expect(screen.getByText("42").className).toMatch(/@[a-z0-9]+\/figure:text-/);
      } else {
        expect(figure.className).not.toMatch(/@container/);
      }
      cleanup();
    }
    expect(valueClasses.size).toBe(4);
  });

  it("sets mono, a signed delta and end alignment", () => {
    const formatDelta = vi.fn((magnitude: number) => `€${magnitude}`);
    render(
      createElement(kit.Figure, {
        value: "€12,400",
        mono: true,
        delta: 300,
        formatDelta,
        align: "end",
        "data-testid": "figure",
      })
    );
    const figure = screen.getByTestId("figure");
    expect(element(screen.getByText("€12,400")).className).toContain("font-mono");
    expect(figure.textContent).toContain("+€300");
    expect(figure.querySelector("svg.lucide-arrow-up")).not.toBeNull();
    expect(formatDelta).toHaveBeenCalledWith(300);
    expect(figure.className).toContain("items-end");
  });

  it("degrades bad props to the default figure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loose = markup(
      untyped("Figure", {
        value: "7",
        size: "huge",
        align: "middle",
        mono: "yes",
        unit: { not: "a node" },
        formatDelta: "nope",
        delta: Number.NaN,
      })
    );
    warn.mockRestore();
    expect(loose).toBe(markup(createElement(kit.Figure, { value: "7" })));
  });
});

describe("StatCard identity props", () => {
  function stat(props: Record<string, unknown>) {
    render(
      untyped("StatCard", { label: "Spend", value: "€2,140", "data-testid": "stat", ...props })
    );
    return screen.getByTestId("stat");
  }

  it("renders exactly as before when the new props are left out or set to their defaults", () => {
    const base = {
      label: "Spend",
      value: "€2,140",
      hint: "This month",
      delta: -3,
      tone: "warning",
    };
    expect(
      markup(untyped("StatCard", { ...base, size: "md", variant: "outline", hintLines: 1 }))
    ).toBe(markup(untyped("StatCard", base)));
    // Unknown values fall back to the same defaults.
    expect(
      markup(untyped("StatCard", { ...base, size: "xl", variant: "tile", hintLines: "lots" }))
    ).toBe(markup(untyped("StatCard", base)));
  });

  it("draws a larger figure at lg", () => {
    const md = element(stat({}).querySelector("span.font-semibold")).className;
    cleanup();
    const lg = element(stat({ size: "lg" }).querySelector("span.font-semibold")).className;
    expect(lg).not.toBe(md);
    expect(lg).toContain("text-2xl");
  });

  it("recesses a filled card, edging it in a caution tone while the figure stays neutral", () => {
    const outline = stat({}).className;
    cleanup();
    const filled = stat({ variant: "filled" });
    expect(filled.className).not.toBe(outline);
    expect(filled.className).toContain("bg-surface-inset");
    cleanup();
    for (const tone of ["warning", "error", "danger"] as const) {
      const card = stat({ variant: "filled", tone });
      expect(card.className).toContain(`border-status-${tone}`);
      expect(element(screen.getByText("€2,140")).className).not.toMatch(/status/);
      cleanup();
    }
    for (const tone of ["info", "success", "neutral"] as const) {
      expect(stat({ variant: "filled", tone }).className).not.toMatch(/border-status-/);
      cleanup();
    }
    expect(stat({ tone: "warning" }).className).not.toMatch(/border-status-/);
  });

  it("clamps the hint to the lines asked for, or lets it wrap", () => {
    const hintClass = (hintLines: unknown) => {
      stat({ hint: "Groceries, transport and the rest", hintLines });
      const value = element(screen.getByText("Groceries, transport and the rest")).className;
      cleanup();
      return value;
    };
    expect(hintClass(undefined)).toContain("truncate");
    expect(hintClass(2)).toContain("line-clamp-2");
    expect(hintClass(2.4)).toContain("line-clamp-2");
    expect(hintClass(4)).toContain("line-clamp-4");
    // Past the deepest clamp the kit has, the request takes that clamp.
    expect(hintClass(12)).toContain("line-clamp-4");
    const wrap = hintClass("wrap");
    expect(wrap).not.toMatch(/truncate|line-clamp/);
    expect(wrap).toContain("break-words");
    expect(hintClass(0)).toContain("truncate");
    expect(hintClass(-1)).toContain("truncate");
  });

  it("keeps the unit outside the figure's truncation, and sets a twin on its own line", () => {
    const card = stat({ unit: "/mo", twin: "≈ $2,300/mo" });
    const unit = element(screen.getByText("/mo"));
    const value = element(screen.getByText("€2,140"));
    expect(value.className).toContain("truncate");
    expect(value.contains(unit)).toBe(false);
    expect(unit.className).toContain("shrink-0");
    expect(unit.className).not.toContain("truncate");
    const twin = element(screen.getByText("≈ $2,300/mo"));
    expect(twin.tagName).toBe("P");
    expect(twin.className).toContain("tabular-nums");
    expect(card.textContent).toBe("Spend€2,140/mo≈ $2,300/mo");
  });
});

describe("DescriptionList alignment", () => {
  const items = [
    { label: "Rent", value: "€1,200" },
    { label: "Groceries", value: "€480" },
  ];

  function list(props: Record<string, unknown>) {
    const { container } = render(untyped("DescriptionList", { items, ...props }));
    return element(container.querySelector("dl"));
  }

  function tracks(dl: HTMLElement): string[] {
    return /grid-cols-\[([^\]]+)\]/.exec(dl.className)?.[1]?.split("_") ?? [];
  }

  it("keeps the default grid when neither prop is set or the values are invalid", () => {
    const plain = markup(untyped("DescriptionList", { items }));
    expect(markup(untyped("DescriptionList", { items, valueAlign: "start" }))).toBe(plain);
    expect(
      markup(untyped("DescriptionList", { items, valueAlign: "right", labelWidth: -40 }))
    ).toBe(plain);
    expect(markup(untyped("DescriptionList", { items, labelWidth: "" }))).toBe(plain);
  });

  it("ends values on the trailing edge with tabular digits", () => {
    const dl = list({ valueAlign: "end" });
    const template = tracks(dl);
    expect(template).toHaveLength(4);
    // The value track takes the free width, so values meet the trailing edge.
    expect(template[1]).toContain("1fr");
    expect(template[3]).not.toContain("fr");
    const value = element(screen.getByText("€480").parentElement);
    expect(value.className).toContain("text-end");
    expect(value.className).toContain("tabular-nums");
  });

  it("sets the label column's width in px or as a CSS length", () => {
    const px = list({ labelWidth: 140 });
    expect(px.style.getPropertyValue("--kit-dl-label")).toBe("140px");
    expect(tracks(px)[0]).toBe("var(--kit-dl-label)");
    cleanup();
    const both = list({ labelWidth: "12rem", valueAlign: "end" });
    expect(both.style.getPropertyValue("--kit-dl-label")).toBe("12rem");
    expect(tracks(both)[0]).toBe("var(--kit-dl-label)");
    expect(tracks(both)[1]).toContain("1fr");
  });

  it("leaves a stacked list alone", () => {
    const plain = markup(untyped("DescriptionList", { items, layout: "stacked" }));
    expect(
      markup(
        untyped("DescriptionList", { items, layout: "stacked", valueAlign: "end", labelWidth: 120 })
      )
    ).toBe(plain);
  });
});
