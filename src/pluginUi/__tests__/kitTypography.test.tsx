// @vitest-environment jsdom
import { createElement, Fragment, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";

const dispatch = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import * as kit from "@daintreehq/plugin-ui";
import { PluginKitOwnerContext } from "@/components/PluginKit/kitScope";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

beforeEach(() => {
  dispatch.mockClear();
});

afterEach(cleanup);

// The untyped shape a JavaScript view can send: the adapters must degrade, never throw.
function untyped(name: string, props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement(Reflect.get(kit, name), props, ...children);
}

function withTooltips(children: ReactNode) {
  return createElement(TooltipProvider, null, children);
}

describe("Text", () => {
  it("draws the reading size in primary ink by default, as a span", () => {
    render(createElement(kit.Text, { "data-testid": "t" }, "Body"));
    const text = screen.getByTestId("t");
    expect(text.tagName).toBe("SPAN");
    expect(text.className).toContain("text-sm");
    expect(text.className).toContain("text-text-primary");
  });

  it("maps size, tone, weight, mono, truncate and element", () => {
    render(
      createElement(
        kit.Text,
        {
          "data-testid": "t",
          size: "2xs",
          tone: "danger",
          weight: "semibold",
          mono: true,
          truncate: true,
          as: "p",
        },
        "Failed"
      )
    );
    const text = screen.getByTestId("t");
    expect(text.tagName).toBe("P");
    for (const token of ["text-2xs", "text-status-danger", "font-semibold", "font-mono"]) {
      expect(text.className).toContain(token);
    }
    expect(text.className).toContain("truncate");
  });

  it("inherits size and tone when asked", () => {
    render(createElement(kit.Text, { "data-testid": "t", size: "inherit", tone: "inherit" }, "x"));
    expect(screen.getByTestId("t").className).not.toMatch(/\btext-/);
  });

  it("ignores values off the ramp and a hostile element", () => {
    render(
      untyped(
        "Text",
        {
          "data-testid": "t",
          size: "13px",
          tone: "#f00",
          as: "script",
          weight: 700,
        },
        "x"
      )
    );
    const text = screen.getByTestId("t");
    expect(text.tagName).toBe("SPAN");
    expect(text.className).toContain("text-sm");
    expect(text.className).toContain("text-text-primary");
    expect(text.className).not.toContain("font-");
  });
});

describe("Heading", () => {
  it("maps each level to its own element and a distinct size", () => {
    const sizeOf = (element: HTMLElement) =>
      element.className.split(" ").find((token) => /^text-(xs|sm|base|lg)$/.test(token));
    const sizes = new Set<string | undefined>();
    for (const level of [1, 2, 3, 4] as const) {
      render(createElement(kit.Heading, { level }, `Level ${level}`));
      const heading = screen.getByRole("heading", { name: `Level ${level}`, level });
      expect(heading.tagName).toBe(`H${level}`);
      sizes.add(sizeOf(heading));
    }
    expect(sizes.size).toBe(4);
    expect(sizes.has(undefined)).toBe(false);
  });

  it("keeps the outline level when drawn as another element", () => {
    render(createElement(kit.Heading, { level: 3, as: "h2" }, "Section"));
    expect(screen.getByRole("heading", { level: 2 }).className).toContain("text-sm");
    cleanup();
    render(createElement(kit.Heading, { level: 4, as: "div" }, "Group"));
    expect(screen.getByRole("heading", { level: 4, name: "Group" }).tagName).toBe("DIV");
  });

  it("defaults to level 2 for a bad level", () => {
    render(untyped("Heading", { level: 9 }, "Title"));
    expect(screen.getByRole("heading", { level: 2 }).tagName).toBe("H2");
  });
});

describe("Link", () => {
  it("opens an http link in the browser without navigating", () => {
    render(createElement(kit.Link, { href: "https://example.com/a" }, "Docs"));
    const link = screen.getByRole("link", { name: "Docs" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(
      "browser.openExternal",
      { url: "https://example.com/a" },
      { source: "user" }
    );
  });

  it("opens a relative path in the file viewer, contained by rootPath", () => {
    render(
      createElement(
        kit.Link,
        { href: "src/index.ts", basePath: "/repo/", rootPath: "/repo" },
        "index.ts"
      )
    );
    fireEvent.click(screen.getByRole("link", { name: "index.ts" }));
    expect(dispatch).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/src/index.ts", rootPath: "/repo", confineToRoot: true },
      { source: "user" }
    );
  });

  it("opens nothing for a path that escapes the root, or with no root at all", () => {
    render(createElement(kit.Link, { href: "../../etc/passwd", rootPath: "/repo" }, "Escape"));
    render(createElement(kit.Link, { href: "notes.md" }, "Rootless"));
    fireEvent.click(screen.getByRole("link", { name: "Escape" }));
    fireEvent.click(screen.getByRole("link", { name: "Rootless" }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves the click to an author handler that prevents it", () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(createElement(kit.Link, { href: "https://example.com", onClick }, "Mine"));
    fireEvent.click(screen.getByRole("link", { name: "Mine" }));
    expect(onClick).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never lets the href navigate, even when the author's handler throws", () => {
    const onClick = () => {
      throw new Error("author bug");
    };
    render(createElement(kit.Link, { href: "index.html", onClick }, "Broken"));
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const onError = (error: ErrorEvent) => error.preventDefault();
    window.addEventListener("error", onError);
    try {
      screen.getByRole("link", { name: "Broken" }).dispatchEvent(event);
    } catch {
      // React rethrows the handler's error; the cancellation is what matters.
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("is underlined at rest, not only on hover or focus", () => {
    render(createElement(kit.Link, { href: "https://example.com" }, "Docs"));
    const tokens = screen.getByRole("link", { name: "Docs" }).className.split(" ");
    // A bare `underline`: the link reads as one without its colour.
    expect(tokens).toContain("underline");
  });

  it("names the external arrow and carries the focus ring", () => {
    render(createElement(kit.Link, { href: "https://example.com", externalIcon: true }, "Site"));
    const link = screen.getByRole("link", { name: /^Site.*opens in browser/ });
    expect(link.className).toContain("text-text-link");
    expect(link.className).toContain("focus-visible:outline-accent-primary");
    expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws no arrow for a file link", () => {
    render(createElement(kit.Link, { href: "a.md", rootPath: "/r", externalIcon: true }, "a"));
    expect(screen.getByRole("link", { name: "a" }).querySelector("svg")).toBeNull();
  });
});

describe("InlineCode", () => {
  it("is a code span in the mono face", () => {
    render(createElement(kit.InlineCode, { "data-testid": "c" }, "npm test"));
    const code = screen.getByTestId("c");
    expect(code.tagName).toBe("CODE");
    expect(code.className).toContain("font-mono");
  });
});

// Long enough for the lazy highlighter chunk and a grammar lookup to resolve.
const HIGHLIGHTER_SETTLE_MS = 20;

describe("CodeBlock", () => {
  const source = "const a = 1;\n\nconst b = 2;\n";

  it("renders every line and drops the trailing newline", () => {
    const { container } = render(
      withTooltips(createElement(kit.CodeBlock, { code: source, "aria-label": "Example" }))
    );
    expect(screen.getByRole("group", { name: "Example" })).toBeTruthy();
    expect(container.querySelectorAll("[data-line]")).toHaveLength(3);
  });

  it("keeps the copy button out of the scrolling code", () => {
    const { container } = render(
      withTooltips(createElement(kit.CodeBlock, { code: "x".repeat(400) }))
    );
    const button = screen.getByRole("button", { name: "Copy code" });
    expect(container.querySelector("pre")?.contains(button)).toBe(false);
    expect(button.closest("[class*='absolute']")).toBeNull();
  });

  it("copies the code without the gutter numbers", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      withTooltips(createElement(kit.CodeBlock, { code: source, lineNumbers: true, startLine: 40 }))
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("const a = 1;\n\nconst b = 2;"));
  });

  it("falls back to plain text for an unknown or prototype-named language", async () => {
    for (const language of ["constructor", "__proto__", "klingon"]) {
      const { container, unmount } = render(
        createElement(kit.CodeBlock, { code: "x = 1", language, copyable: false })
      );
      // Let the highlighter load and the effect settle; it must not throw.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, HIGHLIGHTER_SETTLE_MS));
      });
      expect(container.querySelector("[data-line]")?.textContent).toContain("x = 1");
      expect(container.querySelector(".token")).toBeNull();
      unmount();
    }
  });

  it("numbers lines from startLine and marks highlighted lines", () => {
    const { container } = render(
      withTooltips(
        createElement(kit.CodeBlock, {
          code: source,
          lineNumbers: true,
          startLine: 10,
          highlightLines: [10, 12, 99, -1, 10.5],
        })
      )
    );
    const lines = container.querySelectorAll<HTMLElement>("[data-line]");
    expect(lines[0]?.textContent).toContain("10");
    expect(lines[2]?.textContent).toContain("12");
    const marked = container.querySelectorAll("[data-highlighted]");
    expect(marked).toHaveLength(2);
    expect(marked[0]?.querySelector("mark")).toBeTruthy();
    // The numbers are never read or copied.
    expect(lines[0]?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("scrolls past maxHeight, wraps on request and hides the copy button", () => {
    const { container } = render(
      createElement(kit.CodeBlock, { code: "x", maxHeight: 120, wrap: true, copyable: false })
    );
    const pre = container.querySelector("pre");
    expect(pre?.style.maxHeight).toBe("120px");
    expect(container.querySelector("[data-line] span")?.className).toContain("whitespace-pre-wrap");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("highlights a registered grammar once the highlighter loads", async () => {
    const { container } = render(
      withTooltips(createElement(kit.CodeBlock, { code: "const x = 1;", language: "ts" }))
    );
    await vi.waitFor(() => {
      expect(container.querySelector(".token.keyword")?.textContent).toBe("const");
    });
    expect(container.querySelector("[data-line]")?.textContent).toContain("const x = 1;");
  });

  it("keeps a multi-line token on each line it spans", async () => {
    const { container } = render(
      withTooltips(
        createElement(kit.CodeBlock, { code: "/* one\ntwo */\nlet y;", language: "javascript" })
      )
    );
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".token.comment")).toHaveLength(2);
    });
    expect(container.querySelectorAll("[data-line]")).toHaveLength(3);
  });

  it("survives a bad code value", () => {
    const { container } = render(untyped("CodeBlock", { code: 42, copyable: false }));
    expect(container.querySelectorAll("[data-line]")).toHaveLength(1);
  });
});

describe("PathLabel", () => {
  it("splits the directory from the file name", () => {
    render(
      withTooltips(
        createElement(kit.PathLabel, {
          path: "src/components/Settings/Agent.tsx",
          "data-testid": "p",
        })
      )
    );
    const label = screen.getByTestId("p");
    const directory = label.querySelector("[data-kit-path-directory]");
    expect(directory?.textContent).toBe("src/components/Settings/");
    expect(directory?.className).toContain("[direction:rtl]");
    expect(label.lastElementChild?.textContent).toBe("Agent.tsx");
  });

  it("draws a bare name and a Windows path", () => {
    render(withTooltips(createElement(kit.PathLabel, { path: "README.md", "data-testid": "a" })));
    expect(screen.getByTestId("a").querySelector("[data-kit-path-directory]")).toBeNull();
    render(withTooltips(createElement(kit.PathLabel, { path: "C:\\w\\a.ts", "data-testid": "b" })));
    expect(screen.getByTestId("b").lastElementChild?.textContent).toBe("a.ts");
  });

  it("is not a tab stop while it fits", () => {
    render(withTooltips(createElement(kit.PathLabel, { path: "a/b.ts", "data-testid": "p" })));
    expect(screen.getByTestId("p").getAttribute("tabindex")).toBeNull();
  });
});

describe("VisuallyHidden and LiveRegion", () => {
  it("hides content visually only", () => {
    render(createElement(kit.VisuallyHidden, { "data-testid": "v", as: "div" }, "Hidden"));
    const hidden = screen.getByTestId("v");
    expect(hidden.tagName).toBe("DIV");
    expect(hidden.className).toBe("sr-only");
    expect(hidden.textContent).toBe("Hidden");
  });

  it("is a polite atomic status by default and an alert when assertive", () => {
    render(createElement(kit.LiveRegion, {}, "3 results"));
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    render(
      createElement(
        kit.LiveRegion,
        { politeness: "assertive", atomic: false, visuallyHidden: true },
        "Failed"
      )
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("false");
    expect(alert.className).toContain("sr-only");
  });
});

describe("useAnnounce", () => {
  it("speaks through the host announcer and ignores empty messages", () => {
    const announce = vi.spyOn(useAnnouncerStore.getState(), "announce");
    let speak: ReturnType<typeof kit.useAnnounce> | undefined;
    function Probe() {
      speak = kit.useAnnounce();
      return null;
    }
    render(createElement(Probe));
    act(() => {
      speak?.("Saved");
      speak?.("Sync failed", { politeness: "assertive" });
      speak?.("   ");
      Reflect.apply(speak ?? (() => {}), undefined, [42]);
    });
    expect(announce.mock.calls).toEqual([
      ["Saved", "polite"],
      ["Sync failed", "assertive"],
    ]);
    announce.mockRestore();
  });

  it("returns the same function every render", () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(kit.useAnnounce());
      return null;
    }
    const { rerender } = render(createElement(Probe));
    rerender(createElement(Probe));
    expect(seen[0]).toBe(seen[1]);
  });
});

describe("Portal", () => {
  it("renders into the body under a style root stamped with the plugin", () => {
    render(
      createElement(
        PluginKitOwnerContext,
        { value: "acme.notes" },
        createElement(kit.Portal, null, createElement("div", { "data-testid": "floating" }))
      )
    );
    const floating = screen.getByTestId("floating");
    const root = floating.parentElement;
    expect(root?.hasAttribute(PLUGIN_STYLE_ROOT_ATTRIBUTE)).toBe(true);
    expect(root?.className).toContain("contents");
    expect(root?.parentElement).toBe(document.body);
    expect(root?.outerHTML).toContain("acme.notes");
  });

  it("renders into a given container", () => {
    const host = document.createElement("section");
    document.body.appendChild(host);
    render(createElement(kit.Portal, { container: host }, "Inside"));
    expect(host.textContent).toBe("Inside");
    host.remove();
  });
});

describe("StatusDot", () => {
  it("gives every state its own ink, draws idle hollow, and is decorative unlabelled", () => {
    const fills = new Set<string>();
    for (const state of ["running", "waiting", "error", "success", "neutral", "idle"] as const) {
      render(createElement(kit.StatusDot, { state, "data-testid": state }));
      const dot = screen.getByTestId(state);
      const fill = dot.className.split(" ").find((token) => /^bg-(?!transparent)/.test(token));
      if (state === "idle") {
        // Shape, not colour alone: a ring with no fill.
        expect(fill).toBeUndefined();
        expect(dot.className).toMatch(/\bborder\b/);
      } else {
        expect(fill).toBeDefined();
        fills.add(fill!);
        // Forced colours would paint the fill as Canvas; each keeps a system ink.
        expect(dot.className).toContain("forced-colors:bg-[CanvasText]");
      }
      expect(dot.getAttribute("aria-hidden")).toBe("true");
    }
    expect(fills.size).toBe(5);
  });

  it("is a named image with a label, pulses and grows on request", () => {
    render(
      createElement(kit.StatusDot, {
        state: "running",
        label: "Deploying",
        pulse: true,
        size: "md",
      })
    );
    const dot = screen.getByRole("img", { name: "Deploying" });
    expect(dot.className).toContain("animate-activity-pulse");
    expect(dot.className).toContain("h-2");
  });

  it("falls back to neutral for an unknown state", () => {
    render(untyped("StatusDot", { state: "exploded", "data-testid": "d" }));
    expect(screen.getByTestId("d").getAttribute("data-state")).toBe("neutral");
  });
});

describe("StateGlyph", () => {
  it("draws the app's glyph per state", () => {
    const { container } = render(
      createElement("div", null, [
        createElement(kit.StateGlyph, { key: "r", state: "running", label: "Running" }),
        createElement(kit.StateGlyph, { key: "e", state: "error", size: 20 }),
      ])
    );
    const running = screen.getByRole("img", { name: "Running" });
    expect(running.querySelector(".spinner-circle")?.className).toContain("animate-spin-slow");
    const error = container.querySelector('[data-state="error"]');
    expect(error?.getAttribute("aria-hidden")).toBe("true");
    expect(error?.querySelector("svg")?.getAttribute("class")).toContain("text-status-danger");
  });
});

describe("ColoredLabel", () => {
  it("tints the label with its colour and a readable text colour", () => {
    render(createElement(kit.ColoredLabel, { color: "#d73a4a", "data-testid": "l" }, "bug"));
    const label = screen.getByTestId("l");
    expect(label.style.backgroundColor).toMatch(/rgba\(215, 58, 74/);
    expect(label.style.color).not.toBe("");
    expect(label.style.boxShadow).toContain("inset");
    expect(label.textContent).toBe("bug");
  });

  it("lets a long name wrap inside a shrinkable chip", () => {
    render(
      createElement(
        kit.ColoredLabel,
        { color: "#5319e7", "data-testid": "l" },
        "area: ingest pipeline / retry policy"
      )
    );
    const label = screen.getByTestId("l");
    expect(label.className).not.toContain("whitespace-nowrap");
    expect(label.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
    expect(label.firstElementChild?.className).toContain("line-clamp-2");
  });

  it("edges a dot swatch only when it would vanish into the pane", () => {
    document.documentElement.dataset.colorMode = "light";
    onTestFinished(() => {
      delete document.documentElement.dataset.colorMode;
    });
    render(
      createElement(
        kit.ColoredLabel,
        { color: "#ffffff", variant: "dot", "data-testid": "w" },
        "white"
      )
    );
    render(
      createElement(
        kit.ColoredLabel,
        { color: "#d73a4a", variant: "dot", "data-testid": "r" },
        "red"
      )
    );
    const swatch = (id: string) => screen.getByTestId(id).querySelector("[aria-hidden]");
    // jsdom has no theme tokens, so the light polarity's fallback surface (white) applies.
    expect(swatch("w")?.hasAttribute("data-edged")).toBe(true);
    expect(swatch("r")?.hasAttribute("data-edged")).toBe(false);
  });

  it("draws the forge label chip as the dot variant", () => {
    render(
      createElement(kit.ColoredLabel, { color: "0e8a16", variant: "dot", "data-testid": "l" }, "ok")
    );
    const label = screen.getByTestId("l");
    expect(label.style.backgroundColor).toBe("");
    const dot = label.querySelector<HTMLElement>("[aria-hidden]");
    expect(dot?.style.getPropertyValue("--kit-label-dot")).toBe("rgb(14, 138, 22)");
    // The fill reads the variable, so the forced-colours fill can still win.
    expect(dot?.style.backgroundColor).toBe("");
  });

  it("draws a plain neutral badge for a colour it cannot read", () => {
    render(untyped("ColoredLabel", { color: "red", "data-testid": "l" }, "x"));
    expect(screen.getByTestId("l").style.backgroundColor).toBe("");
  });
});

describe("UnreadDot", () => {
  it("sits on its child's corner and describes a lone element", () => {
    render(
      createElement(
        kit.UnreadDot,
        { label: "Unread replies" },
        createElement("button", { type: "button" }, "Inbox")
      )
    );
    const button = screen.getByRole("button", { name: "Inbox" });
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Unread replies");
    const dot = button.parentElement?.querySelector("[data-kit-unread-dot]");
    expect(dot?.className).toContain("absolute");
    expect(dot?.className).toContain("-top-0.5");
  });

  it("keeps an existing description and honours visible=false", () => {
    render(
      createElement(
        kit.UnreadDot,
        { label: "New", visible: false },
        createElement("button", { type: "button", "aria-describedby": "own" }, "A")
      )
    );
    const button = screen.getByRole("button", { name: "A" });
    expect(button.getAttribute("aria-describedby")).toBe("own");
    expect(button.parentElement?.querySelector("[data-kit-unread-dot]")).toBeNull();
  });

  it("keeps its description readable around a fragment", () => {
    render(
      createElement(
        kit.UnreadDot,
        { label: "Unread" },
        createElement(Fragment, null, createElement("button", { type: "button" }, "Inbox"))
      )
    );
    const button = screen.getByRole("button", { name: "Inbox" });
    expect(button.getAttribute("aria-describedby")).toBeNull();
    const description = button.parentElement?.querySelector(".sr-only");
    expect(description?.textContent).toBe("Unread");
    expect(description?.getAttribute("aria-hidden")).toBeNull();
  });

  it("is an inline dot alone", () => {
    render(createElement(kit.UnreadDot, { label: "Unread" }));
    expect(screen.getByRole("img", { name: "Unread" })).toBeTruthy();
  });
});

describe("CountIndicator", () => {
  it("draws NavList's count pill inline and caps it", () => {
    render(createElement(kit.CountIndicator, { count: 150, "data-testid": "c" }));
    const pill = screen.getByTestId("c");
    expect(pill.textContent).toContain("99+");
    expect(pill.className).toContain("rounded-full");
    expect(pill.querySelector(".sr-only")?.textContent).toBe("More than 99");
  });

  it("draws nothing for zero unless asked", () => {
    const { container } = render(createElement(kit.CountIndicator, { count: 0 }));
    expect(container.textContent).toBe("");
    render(createElement(kit.CountIndicator, { count: 0, showZero: true, "data-testid": "z" }));
    expect(screen.getByTestId("z").textContent).toBe("0");
  });

  it("puts a solid bubble on its child and describes it", () => {
    render(
      createElement(
        kit.CountIndicator,
        { count: 7, max: 5, label: "7 unread", placement: "bottom-left" },
        createElement("button", { type: "button" }, "Mail")
      )
    );
    const button = screen.getByRole("button", { name: "Mail" });
    const bubble = button.parentElement?.querySelector("[data-kit-count-indicator]");
    expect(bubble?.textContent).toBe("5+");
    expect(bubble?.className).toContain("bg-text-secondary");
    // It overlaps its anchor's corner rather than centring on it, so it never
    // rises past the chrome the anchor sits in (pane headers clip paint).
    expect(bubble?.className).not.toMatch(/translate/);
    expect(bubble?.className).toMatch(/(^|\s)-bottom-/);
    expect(bubble?.className).toMatch(/(^|\s)-left-/);
    const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("7 unread");
  });

  it("ignores a bad count and max", () => {
    const { container } = render(untyped("CountIndicator", { count: "12", max: -3 }));
    expect(container.textContent).toBe("");
  });
});
