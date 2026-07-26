/**
 * @vitest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalVisibilityObserver } from "../useTerminalVisibilityObserver";

const mocks = vi.hoisted(() => ({
  getAttachGeneration: vi.fn(() => 1),
  setVisible: vi.fn(),
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    getAttachGeneration: mocks.getAttachGeneration,
    setVisible: mocks.setVisible,
  },
}));

/**
 * Retains every callback ever registered, including across `disconnect()`, so a
 * superseded observer's queued reading can still be delivered by hand — the
 * #10416 scenario the generation guard exists for.
 */
class FakeIntersectionObserver implements IntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  disconnected = false;
  observed: Element[] = [];
  readonly root: Document | Element | null;
  readonly rootMargin: string;
  readonly scrollMargin: string = "0px";
  readonly thresholds: readonly number[];

  constructor(
    private callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    this.thresholds = options?.threshold === undefined ? [0] : [options.threshold].flat();
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }

  unobserve() {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  disconnect() {
    this.disconnected = true;
  }

  /** Deliver a reading as the browser would, batched entries and all. */
  deliver(...isIntersecting: boolean[]) {
    const target = this.observed[0] ?? document.createElement("div");
    const entries = isIntersecting.map((flag) => {
      // Only `isIntersecting` is read by the observer; the rest is filled in so
      // the fixture is a real entry rather than a cast-away partial.
      const rect = new DOMRect(0, 0, 0, 0);
      return {
        boundingClientRect: rect,
        intersectionRatio: flag ? 1 : 0,
        intersectionRect: rect,
        isIntersecting: flag,
        rootBounds: null,
        target,
        time: 0,
      };
    });
    act(() => {
      this.callback(entries, this);
    });
  }
}

/** Overlaps jsdom's viewport, so a `false` reading reads as stale (#9780). */
const ON_SCREEN = new DOMRect(0, 100, 400, 300);
/** Far below the viewport, so a `false` reading is a genuine hide. */
const OFF_SCREEN = new DOMRect(0, 5000, 400, 300);

function setup(
  overrides: {
    gridScrollRoot?: HTMLElement | null;
    containerRect?: DOMRect;
    isDragging?: boolean;
  } = {}
) {
  const container = document.createElement("div");
  const rect = overrides.containerRect ?? ON_SCREEN;
  container.getBoundingClientRect = () => rect;
  // renderHook cannot attach a real ref, so hand the hook the same shape React
  // would have populated by the time its effects run.
  const containerRef = { current: container };

  const updateVisibility = vi.fn();

  const view = renderHook(
    ({ attachEpoch }: { attachEpoch: number }) =>
      useTerminalVisibilityObserver({
        id: "t1",
        restartKey: 0,
        attachEpoch,
        isDragging: overrides.isDragging ?? false,
        gridScrollRoot: overrides.gridScrollRoot ?? null,
        containerRef,
        updateVisibility,
      }),
    { initialProps: { attachEpoch: 0 } }
  );

  return { view, updateVisibility, container };
}

describe("useTerminalVisibilityObserver", () => {
  const RealIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    globalThis.IntersectionObserver = FakeIntersectionObserver;
    mocks.getAttachGeneration.mockReturnValue(1);
  });

  afterEach(() => {
    globalThis.IntersectionObserver = RealIntersectionObserver;
    vi.clearAllMocks();
  });

  it("commits a reading while the captured generation is still live", () => {
    const { updateVisibility } = setup();

    FakeIntersectionObserver.instances[0]!.deliver(true);

    expect(updateVisibility).toHaveBeenCalledWith("t1", true);
    expect(mocks.setVisible).toHaveBeenCalledWith("t1", true, 1);
  });

  it("commits a genuine hide", () => {
    const { updateVisibility } = setup({ containerRect: OFF_SCREEN });

    FakeIntersectionObserver.instances[0]!.deliver(false);

    expect(updateVisibility).toHaveBeenCalledWith("t1", false);
    expect(mocks.setVisible).toHaveBeenCalledWith("t1", false, 1);
  });

  it("never commits a hide for an element fresh geometry puts on screen (#9780)", () => {
    const { updateVisibility } = setup({ containerRect: ON_SCREEN });

    FakeIntersectionObserver.instances[0]!.deliver(false);

    expect(updateVisibility).not.toHaveBeenCalledWith("t1", false);
    expect(mocks.setVisible).not.toHaveBeenCalledWith("t1", false, expect.anything());
  });

  it("repairs a store stuck hidden when geometry proves the pane on screen", () => {
    const { updateVisibility } = setup({ containerRect: ON_SCREEN });

    // The re-armed observer's first reading can itself be the Chromium
    // false-negative. Dropping it would leave a store that entered hidden stuck
    // there until some later threshold crossing — and nothing else repairs a
    // focused pane.
    FakeIntersectionObserver.instances[0]!.deliver(false);

    expect(updateVisibility).toHaveBeenCalledWith("t1", true);
    expect(mocks.setVisible).toHaveBeenCalledWith("t1", true, 1);
  });

  it("does not upgrade a parked pane whose box overlaps but renders nothing", () => {
    const { updateVisibility, container } = setup({ containerRect: ON_SCREEN });
    // The dock parks live panes in a fixed 0,0 box under
    // content-visibility:hidden — full-size overlap, nothing drawn.
    container.checkVisibility = () => false;

    FakeIntersectionObserver.instances[0]!.deliver(false);

    expect(updateVisibility).not.toHaveBeenCalled();
    expect(mocks.setVisible).not.toHaveBeenCalled();
  });

  it("spends no layout on a superseded callback", () => {
    const { container } = setup();
    const measure = vi.spyOn(container, "getBoundingClientRect");

    mocks.getAttachGeneration.mockReturnValue(2);
    FakeIntersectionObserver.instances[0]!.deliver(false);

    // The generation check runs first precisely so a dead mount site cannot
    // force a reflow it will never use.
    expect(measure).not.toHaveBeenCalled();
  });

  it("resumes writing after an attach that landed post-capture (#11445)", () => {
    const { view, updateVisibility } = setup();
    const first = FakeIntersectionObserver.instances[0]!;

    // XtermAdapter's async attach resumes after this effect already captured
    // the pre-attach generation, so every further reading fails the guard.
    mocks.getAttachGeneration.mockReturnValue(2);
    first.deliver(true);
    expect(updateVisibility).not.toHaveBeenCalled();
    expect(mocks.setVisible).not.toHaveBeenCalled();

    // The attach notification re-arms the observer against the live generation.
    act(() => {
      view.rerender({ attachEpoch: 1 });
    });

    const second = FakeIntersectionObserver.instances[1];
    expect(second).toBeDefined();
    expect(first.disconnected).toBe(true);

    second!.deliver(true);
    expect(updateVisibility).toHaveBeenCalledWith("t1", true);
    expect(mocks.setVisible).toHaveBeenCalledWith("t1", true, 2);
  });

  it("still drops a superseded observer's retained callback (#10416)", () => {
    const { view, updateVisibility } = setup();
    const first = FakeIntersectionObserver.instances[0]!;

    mocks.getAttachGeneration.mockReturnValue(2);
    act(() => {
      view.rerender({ attachEpoch: 1 });
    });

    // A visible reading, deliberately: it sails past the #9780 stale-hide guard,
    // so reaching the store would prove the generation check had stopped
    // holding. The old mount site keeps its own capture and must write nothing.
    first.deliver(true);

    expect(updateVisibility).not.toHaveBeenCalled();
    expect(mocks.setVisible).not.toHaveBeenCalled();
  });

  it("re-arming does not itself write visibility", () => {
    const { view, updateVisibility } = setup();

    act(() => {
      view.rerender({ attachEpoch: 1 });
    });

    // Only a delivered reading may write — the re-arm is an invalidation, not a
    // visibility claim of its own.
    expect(updateVisibility).not.toHaveBeenCalled();
    expect(mocks.setVisible).not.toHaveBeenCalled();
  });

  it("keeps the last batched entry as the authoritative reading", () => {
    const { updateVisibility } = setup({ containerRect: OFF_SCREEN });

    // Under load one callback batches several entries for the same element;
    // only the newest reflects current geometry.
    FakeIntersectionObserver.instances[0]!.deliver(true, false);

    expect(updateVisibility).toHaveBeenCalledTimes(1);
    expect(updateVisibility).toHaveBeenCalledWith("t1", false);
  });

  it("ignores readings while a drag is in flight", () => {
    const { updateVisibility } = setup({ isDragging: true, containerRect: OFF_SCREEN });

    // CSS transforms during drag produce false negatives.
    FakeIntersectionObserver.instances[0]!.deliver(false);

    expect(updateVisibility).not.toHaveBeenCalled();
  });

  it("tracks drag state changes without re-arming the observer", () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () => OFF_SCREEN;
    const containerRef = { current: container };
    const updateVisibility = vi.fn();

    const view = renderHook(
      ({ isDragging }: { isDragging: boolean }) =>
        useTerminalVisibilityObserver({
          id: "t1",
          restartKey: 0,
          attachEpoch: 0,
          isDragging,
          gridScrollRoot: null,
          containerRef,
          updateVisibility,
        }),
      { initialProps: { isDragging: false } }
    );

    act(() => {
      view.rerender({ isDragging: true });
    });
    FakeIntersectionObserver.instances[0]!.deliver(false);
    expect(updateVisibility).not.toHaveBeenCalled();

    act(() => {
      view.rerender({ isDragging: false });
    });
    FakeIntersectionObserver.instances[0]!.deliver(false);
    expect(updateVisibility).toHaveBeenCalledWith("t1", false);

    // Drag state must ride a ref: re-arming on it would run the observer's
    // cleanup on drag START, which is what the mirrored ref exists to avoid.
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
  });

  it("disconnects the live observer on unmount", () => {
    const { view } = setup();

    view.unmount();

    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true);
  });

  it("roots at the grid scroll container when one is provided", () => {
    const root = document.createElement("div");
    setup({ gridScrollRoot: root });

    const observer = FakeIntersectionObserver.instances[0]!;
    expect(observer.root).toBe(root);
    // Outside the grid there is no pre-warm margin; inside it there must be one.
    expect(observer.rootMargin).not.toBe("0px");
  });
});
