// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockCursor, measureAnchor, type CursorTarget } from "@daintreehq/tour/kit";
import { TOUR_CHAPTERS } from "../tourChapters";
import { TourPlayer, type TourAudio } from "@daintreehq/tour";
import { resolveChapterTiming } from "../tourTiming";
import { TourPlayerContext } from "@daintreehq/tour/react";

// jsdom has no layout: a 640×360 canvas the stage draws at 2× from (100, 50),
// and anchor rectangles in screen pixels keyed by name.
const rects = new Map<string, DOMRect>();
const CANVAS = new DOMRect(100, 50, 1280, 720);

function rectOf(el: Element): DOMRect {
  if (el.hasAttribute("data-tour-canvas")) return CANVAS;
  const name = el.getAttribute("data-tour-anchor");
  return (name && rects.get(name)) || new DOMRect(0, 0, 0, 0);
}

class SilentAudio implements TourAudio {
  src: string;
  preload = "";
  currentTime = 0;
  muted = false;
  constructor(src: string) {
    this.src = src;
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
  addEventListener() {}
  removeEventListener() {}
}

let player: TourPlayer;

/** The timeline moving on: the cursor retries a missing target on the next frame. */
function tick() {
  act(() => {
    player.seek(1);
    vi.advanceTimersByTime(20);
  });
}

const layoutProps = ["offsetWidth", "offsetHeight"] as const;
const originalLayout = layoutProps.map((prop) =>
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
);

beforeEach(() => {
  vi.useFakeTimers();
  player = new TourPlayer([resolveChapterTiming(TOUR_CHAPTERS[0]!)], {
    createAudio: (url) => new SilentAudio(url),
    now: () => 0,
    requestFrame: () => 0,
    cancelFrame: () => {},
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  for (const [prop, size] of [
    ["offsetWidth", 640],
    ["offsetHeight", 360],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-tour-canvas") ? size : 0;
      },
    });
  }
});

afterEach(() => {
  cleanup();
  player.dispose();
  rects.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  layoutProps.forEach((prop, i) => {
    const original = originalLayout[i];
    if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
  });
});

function Stage({
  at,
  clickKey = null,
  anchors = ["button"],
}: {
  at: CursorTarget;
  clickKey?: string | null;
  anchors?: string[];
}) {
  return (
    <TourPlayerContext.Provider value={player}>
      <div data-tour-canvas="">
        {anchors.map((name) => (
          <span key={name} data-tour-anchor={name} />
        ))}
        <MockCursor at={at} clickKey={clickKey} />
      </div>
    </TourPlayerContext.Provider>
  );
}

function pointer(container: HTMLElement) {
  return container.querySelector<HTMLElement>("[aria-hidden]")!.style.translate;
}

describe("measureAnchor", () => {
  it("converts a scaled, offset anchor into canvas space", () => {
    rects.set("button", new DOMRect(500, 250, 80, 40));
    const { container } = render(<Stage at={{ x: 0, y: 0 }} />);
    const inside = container.querySelector("[data-tour-anchor]")!;
    expect(measureAnchor(inside, "button")).toEqual({ x: 200, y: 100, width: 40, height: 20 });
  });

  it("finds nothing for an anchor that isn't rendered or has no box", () => {
    const { container } = render(<Stage at={{ x: 0, y: 0 }} anchors={["button", "empty"]} />);
    const inside = container.querySelector("[data-tour-anchor]")!;
    expect(measureAnchor(inside, "missing")).toBeNull();
    expect(measureAnchor(inside, "empty")).toBeNull();
  });
});

describe("MockCursor", () => {
  it("goes to a plain canvas point as given", () => {
    const { container } = render(<Stage at={{ x: 12, y: 34 }} />);
    expect(pointer(container)).toBe("12px 34px");
  });

  it("goes to an anchor's centre plus its offset", () => {
    rects.set("button", new DOMRect(500, 250, 80, 40));
    const { container } = render(<Stage at={{ anchor: "button", dx: 5, dy: -3 }} />);
    expect(pointer(container)).toBe("225px 107px");
    expect(container.querySelector("[data-tour-cursor]")?.getAttribute("data-tour-cursor")).toBe(
      "button"
    );
  });

  it("re-measures once the target's entry transition has settled", () => {
    rects.set("button", new DOMRect(500, 266, 80, 40));
    const { container } = render(<Stage at={{ anchor: "button" }} />);
    expect(pointer(container)).toBe("220px 118px");
    rects.set("button", new DOMRect(500, 250, 80, 40));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(pointer(container)).toBe("220px 110px");
  });

  it("stays where it was, and says so, when the anchor isn't rendered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rects.set("button", new DOMRect(500, 250, 80, 40));
    const { container, rerender } = render(<Stage at={{ x: 12, y: 34 }} />);
    rerender(<Stage at={{ anchor: "missing" }} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(pointer(container)).toBe("12px 34px");
    expect(warn).toHaveBeenCalledWith('[tour] cursor target "missing" is not rendered');
  });

  it("clicks where it arrived, however the target moves after", () => {
    rects.set("button", new DOMRect(500, 250, 80, 40));
    const { container, rerender } = render(<Stage at={{ anchor: "button" }} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // The scene reacts to the click: the dialog holding the button slides away.
    rects.set("button", new DOMRect(500, 300, 80, 40));
    rerender(<Stage at={{ anchor: "button" }} clickKey="1" />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(pointer(container)).toBe("220px 110px");
  });

  it("measures a click on a target it never arrived at", () => {
    rects.set("button", new DOMRect(500, 250, 80, 40));
    const { container, rerender } = render(<Stage at={{ x: 12, y: 34 }} />);
    rerender(<Stage at={{ anchor: "button" }} clickKey="1" />);
    expect(pointer(container)).toBe("220px 110px");
  });

  it("moves on to a click on a different target", () => {
    rects.set("button", new DOMRect(500, 250, 80, 40));
    rects.set("other", new DOMRect(300, 150, 40, 20));
    const { container, rerender } = render(
      <Stage at={{ anchor: "button" }} anchors={["button", "other"]} />
    );
    rerender(<Stage at={{ anchor: "other", dx: 2 }} clickKey="1" anchors={["button", "other"]} />);
    expect(pointer(container)).toBe("112px 55px");
  });

  it("finds a target once a seek brings it back", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    rects.set("button", new DOMRect(500, 250, 80, 40));
    // Seeked straight into a click whose button has already gone.
    const { container, rerender } = render(<Stage at={{ x: 12, y: 34 }} anchors={[]} />);
    rerender(<Stage at={{ anchor: "button" }} clickKey="1" anchors={[]} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(pointer(container)).toBe("12px 34px");
    // A seek back to where the button is still shown.
    rerender(<Stage at={{ anchor: "button" }} clickKey="1" />);
    tick();
    expect(pointer(container)).toBe("220px 110px");
  });

  it("still settles when Strict Mode replays a mount on a click", () => {
    rects.set("button", new DOMRect(500, 266, 80, 40));
    const { container } = render(
      <StrictMode>
        <Stage at={{ anchor: "button" }} clickKey="1" />
      </StrictMode>
    );
    rects.set("button", new DOMRect(500, 250, 80, 40));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(pointer(container)).toBe("220px 110px");
  });
});
