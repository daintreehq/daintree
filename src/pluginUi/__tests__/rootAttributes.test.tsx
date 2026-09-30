// @vitest-environment jsdom
import { createElement, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";

beforeAll(async () => {
  await primeRadix();
  await kit.whenPluginUiReady();
});

afterEach(cleanup);

function mount(element: ReactNode) {
  return render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        VirtuosoMockContext.Provider,
        { value: { viewportHeight: 240, itemHeight: 24 } },
        element
      )
    )
  );
}

// Props go through JSON, as from untyped JS, so each case can add attributes
// its props type does not name; the kit drops what it does not accept.
function renderKit<P extends object>(component: ComponentType<P>, loose: object): Element {
  const props: P = JSON.parse(JSON.stringify(loose));
  const { container } = mount(createElement(component, props));
  const root = container.firstElementChild;
  if (!root) throw new Error("nothing rendered");
  return root;
}

const segments = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
];

const CASES: [string, (extra: object) => Element][] = [
  [
    "Select",
    (extra) =>
      renderKit(kit.Select, {
        options: [{ value: "a", label: "A" }],
        "aria-label": "Pick",
        ...extra,
      }),
  ],
  [
    "SegmentedControl",
    (extra) =>
      renderKit(kit.SegmentedControl, {
        options: segments,
        value: "a",
        "aria-label": "Mode",
        ...extra,
      }),
  ],
  ["EmptyState", (extra) => renderKit(kit.EmptyState, { title: "Nothing yet", ...extra })],
  [
    "LogView",
    (extra) => renderKit(kit.LogView, { lines: ["one", "two"], "aria-label": "Output", ...extra }),
  ],
  ["ProgressBar", (extra) => renderKit(kit.ProgressBar, { value: 0.5, label: "Build", ...extra })],
  [
    "CopyButton",
    (extra) =>
      renderKit(kit.CopyButton, { text: "hello", "aria-label": "Copy greeting", ...extra }),
  ],
  ["Kbd", (extra) => renderKit(kit.Kbd, { children: "K", ...extra })],
  ["KbdChord", (extra) => renderKit(kit.KbdChord, { shortcut: "Cmd+K", ...extra })],
  ["Spinner", (extra) => renderKit(kit.Spinner, { ...extra })],
  ["PaneState", (extra) => renderKit(kit.PaneState, { kind: "error", title: "Failed", ...extra })],
  [
    "Tabs",
    (extra) =>
      renderKit(kit.Tabs, {
        items: [{ value: "a", label: "A" }],
        value: "a",
        "aria-label": "Views",
        ...extra,
      }),
  ],
  [
    "Sparkline",
    (extra) => renderKit(kit.Sparkline, { values: [1, 2], "aria-label": "", ...extra }),
  ],
];

describe("kit root attributes", () => {
  it("puts data-* and id on the root of components with no full DOM props", () => {
    for (const [name, renderCase] of CASES) {
      const root = renderCase({ id: `${name}-id`, "data-testid": `${name}-root`, "data-extra": 3 });
      const hit = screen.getByTestId(`${name}-root`);
      expect(hit, name).toBe(root);
      expect(hit.id, name).toBe(`${name}-id`);
      expect(hit.getAttribute("data-extra"), name).toBe("3");
      cleanup();
    }
  });

  it("forwards aria-* only where the root is the control, and its own attributes win", () => {
    const progress = renderKit(kit.ProgressBar, {
      value: 0.25,
      label: "Upload",
      "aria-describedby": "hint",
      "aria-label": "Overridden",
    });
    expect(progress.getAttribute("role")).toBe("progressbar");
    expect(progress.getAttribute("aria-describedby")).toBe("hint");
    expect(progress.getAttribute("aria-label")).toBe("Upload");
    cleanup();
    const empty = renderKit(kit.EmptyState, {
      title: "Nothing",
      "aria-describedby": "ignored",
    });
    expect(empty.getAttribute("aria-describedby")).toBeNull();
    cleanup();
    const select = renderKit(kit.Select, {
      options: [{ value: "a", label: "A" }],
      "aria-label": "Pick",
      "aria-required": true,
      "aria-invalid": true,
    });
    expect(select.getAttribute("aria-required")).toBe("true");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(select.getAttribute("aria-label")).toBe("Pick");
  });

  it("drops non-scalar and junk attribute values from untyped JS", () => {
    const root = renderKit(kit.ProgressBar, {
      label: "Build",
      id: 7,
      "data-object": { nope: true },
      "data-ok": "yes",
    });
    expect(root.id).toBe("");
    expect(root.hasAttribute("data-object")).toBe(false);
    expect(root.getAttribute("data-ok")).toBe("yes");
  });
});

describe("VirtualList test ids", () => {
  const list = (extra: object) =>
    mount(
      createElement(kit.VirtualList, {
        items: ["a", "b"],
        renderItem: (_index: number, item: unknown) => createElement("span", null, String(item)),
        "aria-label": "Queue",
        id: "queue",
        "data-testid": "rq-list",
        "data-extra": 3,
        ...extra,
      })
    );

  it("keeps the plugin's test id on a focusable list over the virtualiser's own", () => {
    list({ role: "listbox", tabIndex: 0 });
    const hit = screen.getByTestId("rq-list");
    // The scroller, which is the element holding the role, name and keyboard.
    expect(hit).toBe(screen.getByRole("listbox", { name: "Queue" }));
    expect(hit.id).toBe("queue");
    expect(hit.getAttribute("data-extra")).toBe("3");
    expect(hit.hasAttribute("data-virtuoso-scroller")).toBe(true);
    expect(screen.queryByTestId("virtuoso-scroller")).toBeNull();
  });

  it("puts the test id on the list element of a plain list", () => {
    list({});
    const hit = screen.getByTestId("rq-list");
    expect(hit).toBe(screen.getByRole("list", { name: "Queue" }));
    expect(hit.id).toBe("queue");
    expect(hit.getAttribute("data-extra")).toBe("3");
  });
});
