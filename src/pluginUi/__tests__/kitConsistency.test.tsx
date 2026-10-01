// @vitest-environment jsdom
import { createElement, createRef, type FocusEvent } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import "@/components/PluginKit/PluginKit";
import {
  content,
  durationMs,
  hasContent,
  rowCount,
  wholeLimit,
} from "@/components/PluginKit/kitProps";
import { focusLeft, invalidProp, kitAriaInvalid } from "@/components/PluginKit/kitField";
import { runPluginAction, safeFormat } from "@/components/PluginKit/kitDiagnostics";
import { createLazyScope, readLazyChildren } from "@/components/PluginKit/kitLazyChildren";

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
  vi.useRealTimers();
});

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("content presence", () => {
  it("agrees with what renders", () => {
    expect(hasContent(0)).toBe(true);
    expect(hasContent(" ")).toBe(true);
    expect(hasContent(createElement("b"))).toBe(true);
    expect(hasContent([null, "a"])).toBe(true);
    for (const absent of [undefined, null, false, true, "", [], [null], [[false]]]) {
      expect(hasContent(absent)).toBe(false);
      expect(content(absent)).toBeUndefined();
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(hasContent({})).toBe(false);
    expect(content({})).toBeUndefined();
    warn.mockRestore();
  });

  it("lets a Dialog fall back to its action footer when the custom footer is empty", () => {
    render(
      createElement(kit.Dialog, {
        open: true,
        onClose: () => {},
        title: "Rename",
        footer: [],
        primaryAction: { label: "Save", onClick: () => {} },
        children: "Body",
      })
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("malformed content", () => {
  it("drops an array inside itself without walking it", () => {
    const loop: unknown[] = [];
    loop.push(loop, loop);
    expect(hasContent(loop)).toBe(false);
    const withText: unknown[] = ["x"];
    withText.push(withText, withText);
    expect(hasContent(withText)).toBe(true);
  });

  it("bounds the work an array shared many times over can make", () => {
    // 2^40 paths through 40 levels, each level the same two-entry array.
    let shared: unknown[] = ["leaf"];
    for (let level = 0; level < 40; level += 1) shared = [shared, shared];
    const started = performance.now();
    hasContent(shared);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("numeric props by meaning", () => {
  it("keeps zero where zero means something", () => {
    expect(durationMs(0, 100)).toBe(0);
    expect(wholeLimit(0, 100)).toBe(0);
    expect(wholeLimit(2.7, 100)).toBe(2);
    expect(rowCount(0.2, 100)).toBe(1);
    expect(rowCount(0, 100)).toBeUndefined();
    for (const bad of [-1, Number.NaN, Infinity, 1000, "3"]) {
      expect(durationMs(bad, 100)).toBeUndefined();
      expect(wholeLimit(bad, 100)).toBeUndefined();
      expect(rowCount(bad, 100)).toBeUndefined();
    }
  });

  it("forwards a zero maxLength", () => {
    render(createElement(kit.Input, { "aria-label": "Code", maxLength: 0 }));
    expect(screen.getByRole("textbox", { name: "Code" }).getAttribute("maxlength")).toBe("0");
  });
});

describe("field normalization", () => {
  it("keeps every aria-invalid value and an explicit invalid", () => {
    expect(kitAriaInvalid(false)).toBe(false);
    expect(kitAriaInvalid("false")).toBe("false");
    expect(kitAriaInvalid("grammar")).toBe("grammar");
    expect(kitAriaInvalid("true")).toBe(true);
    expect(kitAriaInvalid("nope")).toBeUndefined();
    expect(invalidProp(false)).toBe(false);
    expect(invalidProp(undefined)).toBeUndefined();
  });
});

describe("composite focus scope", () => {
  function blurTo(root: HTMLElement, next: Element | null) {
    return { currentTarget: root, relatedTarget: next } as unknown as FocusEvent<HTMLElement>;
  }

  it("stays inside for its own popover and leaves for another control's", () => {
    const root = document.createElement("div");
    const own = document.createElement("div");
    own.setAttribute("data-kit-focus-scope", "outer mine");
    const ownButton = own.appendChild(document.createElement("button"));
    const other = document.createElement("div");
    other.setAttribute("data-kit-focus-scope", "theirs");
    const otherButton = other.appendChild(document.createElement("button"));
    const inside = root.appendChild(document.createElement("input"));
    expect(focusLeft(blurTo(root, inside), "mine")).toBe(false);
    expect(focusLeft(blurTo(root, ownButton), "mine")).toBe(false);
    expect(focusLeft(blurTo(root, ownButton), "outer")).toBe(false);
    expect(focusLeft(blurTo(root, otherButton), "mine")).toBe(true);
    expect(focusLeft(blurTo(root, document.body), "mine")).toBe(true);
    expect(focusLeft(blurTo(root, null), "mine")).toBe(true);
  });
});

describe("ListRow availability", () => {
  it("never toggles membership on an unavailable row", () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(
      createElement(kit.ListRow, {
        role: "option",
        "aria-disabled": true,
        checked: false,
        onToggle,
        title: "Row",
      })
    );
    fireEvent.click(container.querySelector("[data-kit-row-checkbox]")!);
    expect(onToggle).not.toHaveBeenCalled();
    rerender(createElement(kit.ListRow, { disabled: true, checked: true, onToggle, title: "Row" }));
    fireEvent.click(container.querySelector("[data-kit-row-checkbox]")!);
    expect(onToggle).not.toHaveBeenCalled();
    const onClick = vi.fn();
    rerender(
      createElement(kit.ListRow, {
        role: "option",
        checked: false,
        onToggle,
        onClick,
        title: "Row",
      })
    );
    fireEvent.click(container.querySelector("[data-kit-row-checkbox]")!);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("lets the caller veto a row's selection", () => {
    const onSelect = vi.fn();
    render(
      createElement(kit.ListRow, {
        title: "Row",
        onSelect,
        onClick: (event: { preventDefault(): void }) => event.preventDefault(),
      })
    );
    fireEvent.click(screen.getByRole("button", { name: /Row/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("ToolbarButton as a trigger", () => {
  it("forwards a trigger's ref, handlers and disclosure state", () => {
    const ref = createRef<HTMLButtonElement>();
    const onPointerDown = vi.fn();
    const onKeyDown = vi.fn();
    const onFocus = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.ToolbarButton, {
          icon: "filter",
          "aria-label": "Filter",
          ref,
          onPointerDown,
          onKeyDown,
          onFocus,
          "aria-expanded": true,
          pressed: false,
        })
      )
    );
    const button = screen.getByRole("button", { name: "Filter" });
    expect(ref.current).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.hasAttribute("aria-pressed")).toBe(false);
    fireEvent.pointerDown(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.focus(button);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("opens a Popover, and an unavailable one opens nothing", async () => {
    const popover = (disabled: boolean) =>
      createElement(
        TooltipProvider,
        null,
        createElement(kit.Popover, {
          trigger: createElement(kit.ToolbarButton, { label: "Labels", disabled }),
          "aria-label": "Labels",
          children: createElement("p", null, "Panel"),
        })
      );
    const { rerender } = render(popover(true));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    });
    expect(screen.queryByText("Panel")).toBeNull();
    rerender(popover(false));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    });
    expect(await screen.findByText("Panel")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Labels" }).getAttribute("aria-expanded")).toBe(
      "true"
    );
  });
});

describe("branch parity", () => {
  it("keeps a Callout's identity attributes in the strip variant", () => {
    for (const variant of ["box", "strip"] as const) {
      const { container } = render(
        createElement(kit.Callout, {
          severity: "warning",
          variant,
          id: `callout-${variant}`,
          "aria-describedby": "why",
          "data-kind": "quota",
          children: "Nearly full",
        })
      );
      const root = container.querySelector(`#callout-${variant}`);
      expect(root).not.toBeNull();
      expect(root!.getAttribute("aria-describedby")).toBe("why");
      expect(root!.getAttribute("data-kind")).toBe("quota");
      cleanup();
    }
  });
});

describe("InlineEdit activation", () => {
  it("starts editing on Space, as on Enter and F2", () => {
    render(
      createElement(kit.InlineEdit, { "aria-label": "Name", value: "Alpha", onCommit: () => {} })
    );
    const surface = screen.getByRole("button", { name: /Name/ });
    fireEvent.keyDown(surface, { key: " " });
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});

describe("formatter faults", () => {
  it("contains a throwing formatter the same way everywhere", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = () => {
      throw new Error("bad format");
    };
    expect(safeFormat(boom, 3, String)).toBe("3");
    expect(safeFormat(() => 4, 3, String)).toBe("3");
    expect(safeFormat(() => "", 3, String)).toBe("");
    render(createElement(kit.StatCard, { label: "MRR", value: "1", delta: 2, formatDelta: boom }));
    expect(screen.getByText(/2/)).toBeTruthy();
    error.mockRestore();
  });
});

describe("fire-and-forget callbacks", () => {
  it("reports a rejection from a thenable, callable ones included", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const callable = Object.assign(() => {}, {
      then: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error("no")),
    });
    runPluginAction("Probe", () => callable);
    runPluginAction("Probe", () => Promise.reject(new Error("no")));
    runPluginAction("Probe", () => {
      throw new Error("no");
    });
    await tick();
    const lines = logged.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("[plugin-ui] Probe rejected"))).toHaveLength(2);
    expect(lines.filter((line) => line.includes("[plugin-ui] Probe threw"))).toHaveLength(1);
  });

  it("reports a broken formatter at most once per interval", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1_000_000_000);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = () => {
      throw new Error("bad format");
    };
    safeFormat(boom, 1, String);
    safeFormat(boom, 2, String);
    expect(logged).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5_000);
    safeFormat(boom, 3, String);
    expect(logged).toHaveBeenCalledTimes(2);
  });
});

describe("data limits", () => {
  it("says when a BarChart drew only its first categories", () => {
    const data = Array.from({ length: 1001 }, (_, index) => ({ day: `d${index}`, passed: 1 }));
    const { container } = render(
      createElement(kit.BarChart, {
        data,
        x: "day",
        series: [{ key: "passed", label: "Passed" }],
        "aria-label": "Builds",
      })
    );
    expect(container.querySelector("[data-chart-limit]")?.textContent).toBe(
      "Showing the first 1,000 of 1,001 categories"
    );
  });

  it("says a LogView dropped its earlier lines", () => {
    const { container } = render(
      createElement(
        VirtuosoMockContext.Provider,
        { value: { viewportHeight: 300, itemHeight: 20 } },
        createElement(kit.LogView, {
          lines: Array.from({ length: 8 }, (_, index) => `line ${index}`),
          maxLines: 5,
          follow: false,
          "aria-label": "Log",
        })
      )
    );
    expect(container.querySelector("[data-log-dropped]")?.textContent).toBe(
      "3 earlier lines not kept"
    );
  });
});

describe("lazy children", () => {
  it("notifies only the scope whose load settled", async () => {
    const a = createLazyScope();
    const b = createLazyScope();
    const heardA = vi.fn();
    const heardB = vi.fn();
    a.subscribe(heardA);
    b.subscribe(heardB);
    readLazyChildren(a, "root", () => Promise.resolve(["x"]));
    await Promise.resolve();
    await Promise.resolve();
    expect(heardA).toHaveBeenCalled();
    expect(heardB).not.toHaveBeenCalled();
  });

  it("keeps a settlement when the thenable throws after it", () => {
    const scope = createLazyScope();
    const entry = readLazyChildren<string>(scope, "root", () => ({
      then: (resolve: (items: string[]) => void) => {
        resolve(["x"]);
        throw new Error("late");
      },
    }));
    expect(entry).toEqual({ status: "done", items: ["x"] });
  });

  it("returns a thenable that settles during the call as settled", () => {
    const scope = createLazyScope();
    const entry = readLazyChildren<string>(scope, "root", () => ({
      then: (resolve: (items: string[]) => void) => resolve(["x"]),
    }));
    expect(entry).toEqual({ status: "done", items: ["x"] });
  });
});

describe("composite blur in a real picker", () => {
  it("stays in the field moving into its own popover, and leaves once", async () => {
    const onBlur = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.DateTimePicker, { "aria-label": "Starts", onBlur })
      )
    );
    // Read before the modal popover hides the page from the accessibility tree.
    const date = screen.getByRole("textbox", { name: "Date" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose date" }));
    });
    const panel = await screen.findByRole("dialog", { name: "Choose date" });
    const day = panel.querySelector("button")!;
    fireEvent.focusOut(date, { relatedTarget: day });
    expect(onBlur).not.toHaveBeenCalled();
    // Another control's popover is outside this field, though it is a popper too.
    const foreign = document.body.appendChild(document.createElement("div"));
    foreign.setAttribute("data-radix-popper-content-wrapper", "");
    const elsewhere = foreign.appendChild(document.createElement("button"));
    fireEvent.focusOut(date, { relatedTarget: elsewhere });
    expect(onBlur).toHaveBeenCalledTimes(1);
    foreign.remove();
  });
});

describe("menus opened from a ToolbarButton", () => {
  it("opens a DropdownMenu from the keyboard", async () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.DropdownMenu, {
          trigger: createElement(kit.ToolbarButton, { label: "Sort" }),
          items: [{ label: "By name", onSelect: () => {} }],
        })
      )
    );
    const trigger = screen.getByRole("button", { name: "Sort" });
    trigger.focus();
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("opens no ContextMenu on an unavailable one", async () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.ContextMenu, {
          items: [{ label: "Rename", onSelect: () => {} }],
          "aria-label": "Tool actions",
          children: createElement(kit.ToolbarButton, { label: "Tool", disabled: true }),
        })
      )
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "Tool" }), { clientX: 5, clientY: 5 });
    await tick();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("stable identity across configuration changes", () => {
  it("keeps the rich table mounted when its hidden columns clear", () => {
    const table = (hiddenColumns: string[]) =>
      createElement(kit.DataTable, {
        "aria-label": "Files",
        columns: [
          { id: "name", header: "Name" },
          { id: "size", header: "Size" },
        ],
        rows: [{ id: "a", name: "a", size: 1 }],
        rowKey: "id",
        hiddenColumns,
      });
    const { container, rerender } = render(table(["size"]));
    const before = container.querySelector("table");
    expect(before).not.toBeNull();
    rerender(table([]));
    expect(container.querySelector("table")).toBe(before);
  });

  it("scopes a Dialog's element title to the plugin's styles", () => {
    render(
      createElement(kit.Dialog, {
        open: true,
        onClose: () => {},
        title: createElement("em", { className: "plugin-title" }, "Rename"),
        children: "Body",
      })
    );
    const title = document.querySelector(".plugin-title")!;
    expect(title.closest("[data-daintree-plugin-style-root]")).not.toBeNull();
  });
});
