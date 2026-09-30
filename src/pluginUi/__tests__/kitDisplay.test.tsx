// @vitest-environment jsdom
import { createElement, useState, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import {
  AVATAR_CUTOUT_PX,
  AVATAR_GROUP_FIT,
  GROUP_OVERLAP,
  meterTone,
  timelineDayLabel,
  timelineRows,
} from "@/components/PluginKit/PluginKitDisplay";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(cleanup);

function withTooltips(children: ReactNode) {
  return createElement(TooltipProvider, null, children);
}

function inViewport(children: ReactNode, viewportHeight = 400) {
  return createElement(
    VirtuosoMockContext.Provider,
    { value: { viewportHeight, itemHeight: 40 } },
    children
  );
}

// Plugin views are often untyped JS, so the tests hand props over the way it would.
function loose<P extends object>(component: ComponentType<P>, props: object) {
  const typed: P = JSON.parse(JSON.stringify(props));
  return createElement(component, typed);
}

describe("FilterChip", () => {
  it("toggles uncontrolled and reports the next state", () => {
    const onSelectedChange = vi.fn();
    render(createElement(kit.FilterChip, { onSelectedChange, count: 3 }, "Open"));
    const chip = screen.getByRole("button", { name: "Open (3)" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.hasAttribute("data-filter-chip")).toBe(true);
    fireEvent.click(chip);
    expect(onSelectedChange).toHaveBeenLastCalledWith(true);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  it("groups the digits of a large count", () => {
    render(createElement(kit.FilterChip, { count: 2172 }, "Active"));
    expect(screen.getByRole("button", { name: "Active (2,172)" })).toBeTruthy();
  });

  it("follows `selected` when controlled", () => {
    function Controlled() {
      const [on, setOn] = useState(true);
      return createElement(kit.FilterChip, { selected: on, onSelectedChange: setOn }, "Mine");
    }
    render(createElement(Controlled));
    const chip = screen.getByRole("button", { name: "Mine" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("removes an applied filter on click, Backspace and Delete", () => {
    const onRemove = vi.fn();
    const onClick = vi.fn();
    render(
      withTooltips(
        createElement(
          kit.FilterChip,
          { onRemove, onClick, count: 9, "data-testid": "status" },
          "Status: Open"
        )
      )
    );
    const chip = screen.getByTestId("status");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // A removable chip carries the ×, not a count.
    expect(chip.textContent).toBe("Status: Open");
    expect(chip.querySelector("svg[aria-hidden=true]")).not.toBeNull();
    fireEvent.click(chip);
    fireEvent.keyDown(chip, { key: "Backspace" });
    fireEvent.keyDown(chip, { key: "Delete" });
    fireEvent.keyDown(chip, { key: "a" });
    expect(onRemove).toHaveBeenCalledTimes(3);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("degrades bad props to a plain chip", () => {
    expect(() =>
      render(
        loose(kit.FilterChip, {
          selected: "yes",
          count: "many",
          onRemove: "nope",
          onSelectedChange: 4,
          children: { label: "x" },
        })
      )
    ).not.toThrow();
    const chip = screen.getByRole("button");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("HighlightedText", () => {
  it("bands the first case-insensitive match of a query", () => {
    const { container } = render(
      createElement(kit.HighlightedText, { text: "readme then README", query: "README" })
    );
    const bands = container.querySelectorAll(".bg-overlay-medium");
    expect([...bands].map((band) => band.textContent)).toEqual(["readme"]);
    expect(container.textContent).toBe("readme then README");
  });

  it("merges explicit ranges and ignores ones outside the text", () => {
    const { container } = render(
      createElement(kit.HighlightedText, {
        text: "abcdef",
        ranges: [
          [0, 1],
          [2, 3],
          [10, 12],
        ],
        "data-testid": "hl",
      })
    );
    const bands = container.querySelectorAll(".bg-overlay-medium");
    expect([...bands].map((band) => band.textContent)).toEqual(["abcd"]);
    expect(screen.getByTestId("hl").textContent).toBe("abcdef");
  });

  it("renders bad props as plain text", () => {
    const { container } = render(
      loose(kit.HighlightedText, { text: 42, query: { q: 1 }, ranges: [["a", 2], null] })
    );
    expect(container.querySelector(".bg-overlay-medium")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

describe("DiffStat", () => {
  it("draws additions and deletions and leaves out a zero side", () => {
    const { container } = render(
      createElement(kit.DiffStat, { additions: 1200, deletions: 0, "data-testid": "churn" })
    );
    expect(screen.getByTestId("churn").textContent).toBe(`+${(1200).toLocaleString()}`);
    cleanup();
    render(createElement(kit.DiffStat, { additions: 12, deletions: 3 }));
    expect(document.body.textContent).toBe("+12-3");
    void container;
  });

  it("draws nothing for zero, negative or junk counts", () => {
    const { container } = render(loose(kit.DiffStat, { additions: Number.NaN, deletions: "3" }));
    expect(container.textContent).toBe("");
    cleanup();
    const { container: empty } = render(createElement(kit.DiffStat, { additions: -2 }));
    expect(empty.textContent).toBe("");
  });
});

describe("AvatarGroup", () => {
  const people = [
    { name: "Ada Lovelace" },
    { name: "Grace Hopper" },
    { name: "Alan Turing" },
    { name: "Edsger Dijkstra" },
    { name: "dependabot", shape: "square" as const },
  ];

  it("draws up to max and folds the rest into a labelled +N", () => {
    render(
      withTooltips(
        createElement(kit.AvatarGroup, { avatars: people, max: 3, "aria-label": "Reviewers" })
      )
    );
    const group = screen.getByRole("group", { name: "Reviewers" });
    const overflow = screen.getByRole("img", { name: "2 more: Edsger Dijkstra, dependabot" });
    expect(overflow.textContent).toBe("+2");
    expect(overflow.tabIndex).toBe(0);
    expect(group.contains(overflow)).toBe(true);
    expect(group.querySelectorAll("[data-avatar-fallback]")).toHaveLength(3);
  });

  it("has no overflow when everyone fits", () => {
    render(withTooltips(createElement(kit.AvatarGroup, { avatars: people.slice(0, 2) })));
    expect(document.body.textContent).not.toContain("+");
    // Without an aria-label it is not a named group.
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("overlaps each avatar only as far as its initials stay whole", () => {
    const FONT_PX: Record<string, number> = { "text-3xs": 10, "text-2xs": 11 };
    for (const size of ["xs", "sm", "md", "lg"] as const) {
      const fit = AVATAR_GROUP_FIT[size];
      // The class the group draws with is the overlap the fit was sized for.
      expect(Number(GROUP_OVERLAP[size].replace("-space-x-", "")) * 4).toBe(fit.overlap);
      // What the next disc and its cut-out leave of this one must reach past
      // the centred initials, a cap being at most ~0.7em wide.
      const visible = fit.px - fit.overlap - AVATAR_CUTOUT_PX;
      expect(visible).toBeGreaterThanOrEqual(
        fit.px / 2 + (fit.initials * fit.fontPx * 0.7) / 2 + 0.5
      );
      render(
        withTooltips(
          createElement(kit.AvatarGroup, {
            avatars: [{ name: "Grace Hopper" }, { name: "Ada Lovelace" }],
            size,
            "aria-label": "People",
          })
        )
      );
      const group = screen.getByRole("group", { name: "People" });
      expect(group.className.split(" ")).toContain(GROUP_OVERLAP[size]);
      const initials = group.querySelector("[data-avatar-fallback] span")!;
      // And the fit's initials and type size are the ones the avatar draws.
      expect(initials.textContent).toHaveLength(fit.initials);
      const font = initials.className.split(" ").find((name) => name in FONT_PX);
      expect(FONT_PX[font ?? ""]).toBe(fit.fontPx);
      cleanup();
    }
  });

  it("gives every disc its own edge inside the canvas cut-out", () => {
    render(
      withTooltips(
        createElement(kit.AvatarGroup, { avatars: people, max: 2, "aria-label": "People" })
      )
    );
    const group = screen.getByRole("group", { name: "People" });
    for (const disc of group.children) {
      const classes = disc.className.split(" ");
      expect(classes).toContain("ring-surface-canvas");
      expect(classes).toContain("border-border-strong");
    }
  });

  it("skips nameless entries and falls back on a bad max", () => {
    expect(() =>
      render(
        withTooltips(
          loose(kit.AvatarGroup, {
            avatars: [{ src: "x" }, null, "Ada", ...people],
            max: -1,
            size: "huge",
          })
        )
      )
    ).not.toThrow();
    // The default max is 4, so one of the five named people folds away.
    expect(screen.getByRole("img", { name: "1 more: dependabot" }).textContent).toBe("+1");
  });
});

describe("Meter", () => {
  it("is a neutral meter below its thresholds", () => {
    render(
      createElement(kit.Meter, {
        value: 500,
        max: 1000,
        label: "API requests",
        thresholds: { warning: 0.8, danger: 0.95 },
        "data-testid": "quota",
      })
    );
    const meter = screen.getByRole("meter", { name: "API requests" });
    expect(meter.getAttribute("data-testid")).toBe("quota");
    expect(meter.getAttribute("aria-valuenow")).toBe("500");
    expect(meter.getAttribute("aria-valuemax")).toBe("1000");
    expect(meter.getAttribute("aria-valuetext")).toBe("50%");
    expect(meter.getAttribute("data-tone")).toBe("neutral");
    expect(meter.firstElementChild?.getAttribute("style")).toContain("width: 50%");
    expect(document.body.textContent).toContain("API requests");
  });

  it("switches tone at each threshold and says so in words", () => {
    render(
      createElement(kit.Meter, {
        value: 0.97,
        label: "Disk",
        valueText: "97 of 100 GB",
        thresholds: { warning: 0.8, danger: 0.95 },
        showLabel: false,
      })
    );
    const meter = screen.getByRole("meter", { name: "Disk" });
    expect(meter.getAttribute("data-tone")).toBe("danger");
    expect(meter.getAttribute("aria-valuetext")).toBe("97 of 100 GB, danger");
    expect(meter.firstElementChild?.className).toContain("bg-status-danger");
    // No visible label in the inline layout; the value sits beside the bar.
    expect(document.body.textContent).toBe("97 of 100 GB");
    expect(meterTone(0.8, { warning: 0.8 })).toBe("warning");
    expect(meterTone(0.79, { warning: 0.8 })).toBe("neutral");
    expect(meterTone(1, { warning: 2, danger: "high" })).toBe("neutral");
    expect(meterTone(1, null)).toBe("neutral");
  });

  it("clamps and degrades bad props", () => {
    render(loose(kit.Meter, { value: 5, max: -1, label: 7, thresholds: "red" }));
    const meter = screen.getByRole("meter", { name: "Usage" });
    expect(meter.getAttribute("aria-valuemax")).toBe("1");
    expect(meter.getAttribute("aria-valuenow")).toBe("1");
    expect(meter.getAttribute("data-tone")).toBe("neutral");
  });
});

describe("Timeline", () => {
  const now = new Date(2026, 8, 30, 15, 0).getTime();
  const hour = 60 * 60 * 1000;
  const items = [
    { id: "a", title: "opened this pull request", actor: "Ada", timestamp: now - hour },
    {
      id: "b",
      title: "commented",
      actor: { name: "Grace", src: "" },
      timestamp: now - 26 * hour,
      tone: "warning" as const,
      body: "Looks good",
    },
    { id: "c", title: "was created", timestamp: now - 30 * 24 * hour, icon: "git-branch" as const },
  ];

  it("labels days as Today, Yesterday, then the date", () => {
    expect(timelineDayLabel(now - hour, now)).toBe("Today");
    expect(timelineDayLabel(now - 26 * hour, now)).toBe("Yesterday");
    expect(timelineDayLabel(now - 30 * 24 * hour, now)).not.toMatch(/Today|Yesterday/);
  });

  it("puts a header before each day and breaks the rail at it", () => {
    const rows = timelineRows(items, true, now);
    expect(rows.map((row) => row.kind)).toEqual(["day", "entry", "day", "entry", "day", "entry"]);
    expect(rows.every((row) => row.kind === "day" || !row.railBelow)).toBe(true);
    const flat = timelineRows(items, false, now);
    expect(flat.map((row) => (row.kind === "entry" ? row.railBelow : null))).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("keys duplicate ids apart", () => {
    const rows = timelineRows(
      [
        { id: 1, title: "a" },
        { id: 1, title: "b" },
        { id: "1", title: "c" },
      ],
      false,
      now
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it("renders a named list of entries with actors, times and custom content", () => {
    const { container } = render(
      withTooltips(
        inViewport(
          createElement(kit.Timeline<(typeof items)[number]>, {
            items,
            "aria-label": "Activity",
            now,
            groupByDay: true,
            "data-testid": "feed",
            renderContent: (item) =>
              "body" in item ? createElement("p", { "data-comment": "" }, item.body) : null,
          })
        )
      )
    );
    const list = screen.getByRole("list", { name: "Activity" });
    expect(list.getAttribute("data-testid")).toBe("feed");
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("Today")).not.toBeNull();
    expect(screen.getByText("Yesterday")).not.toBeNull();
    const entries = container.querySelectorAll("[data-timeline-entry]");
    expect(entries[0]?.textContent).toContain("Ada opened this pull request");
    expect(entries[0]?.querySelector("time")?.textContent).toBe("1h ago");
    expect(entries[1]?.textContent).toContain("Warning: Grace commented");
    expect(entries[1]?.querySelector("[data-comment]")?.textContent).toBe("Looks good");
    // One entry per day, so no rail runs across a header.
    expect(container.querySelector("[data-timeline-rail]")).toBeNull();
  });

  it("uses the verbose clock on request and joins entries with a rail", () => {
    const { container } = render(
      inViewport(
        createElement(kit.Timeline, {
          items: items.slice(0, 2),
          "aria-label": "Activity",
          now,
          timeFormat: "verbose",
        })
      )
    );
    expect(container.querySelector("time")?.textContent).toBe("1 hour ago");
    expect(container.querySelectorAll("[data-timeline-rail]")).toHaveLength(1);
  });

  it("skips entries without an id and survives junk", () => {
    expect(() =>
      render(
        inViewport(
          loose(kit.Timeline, {
            items: [
              null,
              { title: "no id" },
              { id: "ok", title: { bad: true }, timestamp: "nope" },
            ],
            "aria-label": "Activity",
            renderContent: "not a function",
            estimatedItemSize: -5,
          })
        )
      )
    ).not.toThrow();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(document.querySelector("time")).toBeNull();
  });
});
