// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lazy, Suspense, type ComponentType } from "react";
import { act, render } from "@testing-library/react";
import {
  SettingsDeepLinkScope,
  scrollAndHighlightSettingsSection,
  useSettingsScrollToSection,
} from "../SettingsDialog";
import {
  SettingsDeepLinkHold,
  useHoldSettingsDeepLink,
  useSettingsDeepLink,
} from "../settingsDeepLink";

/**
 * Tests for the deep-link scroll mechanism (#6878).
 *
 * The scroll/highlight is driven by `useSettingsScrollToSection`, a
 * `useLayoutEffect`-based hook hosted inside each settings tab's panel
 * subtree. It fires synchronously when the subtree commits, so the target
 * element is guaranteed to be in the DOM by the time we look for it —
 * replacing the rAF polling loop that raced Suspense reveals on slow
 * hardware.
 */

function setupSection(id: string, withInput = false): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  el.scrollIntoView = vi.fn();
  if (withInput) {
    const input = document.createElement("input");
    el.appendChild(input);
  }
  document.body.appendChild(el);
  return el;
}

describe("scrollAndHighlightSettingsSection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns false and is a no-op when the element is missing", () => {
    expect(scrollAndHighlightSettingsSection("missing")).toBe(false);
  });

  it("scrolls, focuses the first input, and adds the highlight class", () => {
    const el = setupSection("section-foo", true);
    const input = el.querySelector("input")!;
    const focusSpy = vi.spyOn(input, "focus");

    expect(scrollAndHighlightSettingsSection("section-foo")).toBe(true);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(el.classList.contains("settings-highlight")).toBe(true);
  });

  it("focuses a control the section marks for landing ahead of its first field", () => {
    const el = setupSection("section-marked");
    const toggle = document.createElement("button");
    toggle.setAttribute("role", "switch");
    el.appendChild(toggle);
    const marked = document.createElement("button");
    marked.setAttribute("data-settings-focus-target", "");
    el.appendChild(marked);

    scrollAndHighlightSettingsSection("section-marked");

    expect(document.activeElement).toBe(marked);
  });

  it("skips a marked control that is disabled", () => {
    const el = setupSection("section-disabled-mark", true);
    const marked = document.createElement("button");
    marked.setAttribute("data-settings-focus-target", "");
    marked.disabled = true;
    el.appendChild(marked);

    scrollAndHighlightSettingsSection("section-disabled-mark");

    expect(document.activeElement).toBe(el.querySelector("input"));
  });

  it("does not throw when the section has no inner input", () => {
    const el = setupSection("section-bar", false);
    expect(() => scrollAndHighlightSettingsSection("section-bar")).not.toThrow();
    expect(el.classList.contains("settings-highlight")).toBe(true);
  });

  it("removes the highlight class after 1500ms", () => {
    vi.useFakeTimers();
    const el = setupSection("section-baz");
    scrollAndHighlightSettingsSection("section-baz");
    expect(el.classList.contains("settings-highlight")).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(el.classList.contains("settings-highlight")).toBe(false);
  });
});

describe("useSettingsScrollToSection", () => {
  function Probe({
    isActive,
    scrollToSectionId,
    onHandled,
  }: {
    isActive: boolean;
    scrollToSectionId: string | null;
    onHandled: (id: string) => void;
  }) {
    useSettingsScrollToSection(isActive, scrollToSectionId, onHandled);
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrolls and calls onHandled when active with a section id", () => {
    const el = setupSection("section-active");
    const onHandled = vi.fn();

    render(<Probe isActive={true} scrollToSectionId="section-active" onHandled={onHandled} />);

    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledWith("section-active", true);
  });

  it("does nothing when not active", () => {
    const el = setupSection("section-inactive");
    const onHandled = vi.fn();

    render(<Probe isActive={false} scrollToSectionId="section-inactive" onHandled={onHandled} />);

    expect(el.scrollIntoView).not.toHaveBeenCalled();
    expect(onHandled).not.toHaveBeenCalled();
  });

  it("does nothing when scrollToSectionId is null", () => {
    const onHandled = vi.fn();

    render(<Probe isActive={true} scrollToSectionId={null} onHandled={onHandled} />);

    expect(onHandled).not.toHaveBeenCalled();
  });

  it("calls onHandled even when the element is missing (lets parent clear stale state)", () => {
    const onHandled = vi.fn();

    render(<Probe isActive={true} scrollToSectionId="section-missing" onHandled={onHandled} />);

    expect(onHandled).toHaveBeenCalledWith("section-missing", false);
  });

  it("fires once per scrollToSectionId change", () => {
    setupSection("section-a");
    setupSection("section-b");
    const onHandled = vi.fn();

    const { rerender } = render(
      <Probe isActive={true} scrollToSectionId="section-a" onHandled={onHandled} />
    );
    expect(onHandled).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenLastCalledWith("section-a", true);

    // Same id, same deps — no re-fire.
    rerender(<Probe isActive={true} scrollToSectionId="section-a" onHandled={onHandled} />);
    expect(onHandled).toHaveBeenCalledTimes(1);

    // New id — fires.
    rerender(<Probe isActive={true} scrollToSectionId="section-b" onHandled={onHandled} />);
    expect(onHandled).toHaveBeenCalledTimes(2);
    expect(onHandled).toHaveBeenLastCalledWith("section-b", true);
  });

  it("fires when isActive transitions from false to true with a pending id", () => {
    const el = setupSection("section-late");
    const onHandled = vi.fn();

    const { rerender } = render(
      <Probe isActive={false} scrollToSectionId="section-late" onHandled={onHandled} />
    );
    expect(el.scrollIntoView).not.toHaveBeenCalled();

    rerender(<Probe isActive={true} scrollToSectionId="section-late" onHandled={onHandled} />);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledWith("section-late", true);
  });
});

describe("SettingsDeepLinkScope", () => {
  // Content that renders its row only once its values have loaded in, holding the
  // link until then, as a tab hydrating from IPC does.
  function Loading({ loaded, rowId }: { loaded: boolean; rowId: string }) {
    useHoldSettingsDeepLink(!loaded);
    return loaded ? <div id={rowId} /> : null;
  }

  const request = { sectionId: "row-target", query: "gitlab token" };

  function scope(children: React.ReactNode, onHandled = vi.fn(), isActive = true) {
    return (
      <SettingsDeepLinkScope
        isActive={isActive}
        scrollToSectionId={request.sectionId}
        query={request.query}
        request={request}
        onHandled={onHandled}
        tab="voice"
      >
        {children}
      </SettingsDeepLinkScope>
    );
  }

  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView"
  );

  beforeEach(() => {
    document.body.innerHTML = "";
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    } else {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("lands on the first commit when nothing holds it", () => {
    const onHandled = vi.fn();
    render(scope(<Loading loaded rowId="row-target" />, onHandled));
    expect(onHandled).toHaveBeenCalledExactlyOnceWith("row-target", true);
  });

  it("waits for a hold taken on the tab's first commit, then lands on the loaded row", () => {
    const onHandled = vi.fn();
    const { rerender } = render(scope(<Loading loaded={false} rowId="row-target" />, onHandled));
    expect(onHandled).not.toHaveBeenCalled();

    rerender(scope(<Loading loaded rowId="row-target" />, onHandled));
    expect(onHandled).toHaveBeenCalledExactlyOnceWith("row-target", true);
  });

  it("reports a miss once loaded when the row still isn't there", () => {
    const onHandled = vi.fn();
    const { rerender } = render(scope(<Loading loaded={false} rowId="row-other" />, onHandled));
    expect(onHandled).not.toHaveBeenCalled();

    rerender(scope(<Loading loaded rowId="row-other" />, onHandled));
    expect(onHandled).toHaveBeenCalledExactlyOnceWith("row-target", false);
  });

  it("waits for every hold in the tab", () => {
    const onHandled = vi.fn();
    const both = (first: boolean, second: boolean) =>
      scope(
        <>
          <Loading loaded={first} rowId="row-target" />
          <Loading loaded={second} rowId="row-second" />
        </>,
        onHandled
      );
    const { rerender } = render(both(false, false));
    rerender(both(true, false));
    expect(onHandled).not.toHaveBeenCalled();

    rerender(both(true, true));
    expect(onHandled).toHaveBeenCalledExactlyOnceWith("row-target", true);
  });

  it("holds through a Suspense fallback until the content behind it commits", async () => {
    let reveal!: (module: { default: ComponentType }) => void;
    const Lazy = lazy(
      () =>
        new Promise<{ default: ComponentType }>((resolve) => {
          reveal = resolve;
        })
    );
    const onHandled = vi.fn();
    render(
      scope(
        <Suspense fallback={<SettingsDeepLinkHold />}>
          <Lazy />
        </Suspense>,
        onHandled
      )
    );
    expect(onHandled).not.toHaveBeenCalled();

    await act(async () => {
      reveal({ default: () => <div id="row-target" /> });
    });
    expect(onHandled).toHaveBeenCalledExactlyOnceWith("row-target", true);
  });

  it("lands as soon as a tab that finished loading while hidden is shown", () => {
    const onHandled = vi.fn();
    const { rerender } = render(
      scope(<Loading loaded={false} rowId="row-target" />, onHandled, false)
    );
    rerender(scope(<Loading loaded rowId="row-target" />, onHandled, false));
    expect(onHandled).not.toHaveBeenCalled();

    rerender(scope(<Loading loaded rowId="row-target" />, onHandled, true));
    expect(onHandled).toHaveBeenCalledExactlyOnceWith("row-target", true);
  });

  it("lands a link again once it was cleared and asked for anew, but not before", () => {
    const onHandled = vi.fn();
    const linked = (id: string | null, handler: (id: string, landed: boolean) => void) => (
      <SettingsDeepLinkScope
        isActive
        scrollToSectionId={id}
        query={null}
        request={id === null ? null : { sectionId: id }}
        onHandled={handler}
        tab="voice"
      >
        <Loading loaded rowId="row-target" />
      </SettingsDeepLinkScope>
    );
    const { rerender } = render(linked("row-target", onHandled));
    expect(onHandled).toHaveBeenCalledTimes(1);

    // Still pending under a new handler: the same link, already landed.
    const nextHandler = vi.fn();
    rerender(linked("row-target", nextHandler));
    expect(nextHandler).not.toHaveBeenCalled();

    rerender(linked(null, nextHandler));
    rerender(linked("row-target", nextHandler));
    expect(nextHandler).toHaveBeenCalledExactlyOnceWith("row-target", true);
  });

  it("hands the link and its search words only to the tab that's showing", () => {
    const seen: Array<ReturnType<typeof useSettingsDeepLink>> = [];
    function Reader() {
      seen.push(useSettingsDeepLink());
      return null;
    }
    const { rerender } = render(scope(<Reader />, vi.fn(), false));
    expect(seen.at(-1)).toMatchObject({ sectionId: null, query: null, request: null });

    rerender(scope(<Reader />, vi.fn(), true));
    expect(seen.at(-1)).toMatchObject({ sectionId: "row-target", query: "gitlab token" });
    expect(seen.at(-1)?.request).toBe(request);
  });

  it("does nothing outside a settings tab", () => {
    function Standalone() {
      useHoldSettingsDeepLink(true);
      return <div data-testid="standalone" />;
    }
    expect(() => render(<Standalone />)).not.toThrow();
  });
});
