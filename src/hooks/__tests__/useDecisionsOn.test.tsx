// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionsStatus } from "@shared/types/decisions";

const watch = vi.hoisted(() => ({
  listener: null as ((status: DecisionsStatus) => void) | null,
  stop: vi.fn(),
  throws: false,
}));

vi.mock("@/clients/decisionsClient", () => ({
  decisionsClient: {
    watchStatus: (listener: (status: DecisionsStatus) => void) => {
      if (watch.throws) throw new Error("no bridge");
      watch.listener = listener;
      return watch.stop;
    },
  },
}));

import { readDecisionsSwitch, useDecisionsOn, useDecisionsSwitch } from "../useDecisionsOn";

const seen: string[] = [];

function Probe() {
  const decisionsSwitch = useDecisionsSwitch();
  const on = useDecisionsOn();
  seen.push(`${decisionsSwitch}/${on}`);
  return null;
}

const report = (status: DecisionsStatus) => act(() => watch.listener?.(status));

beforeEach(() => {
  seen.length = 0;
  watch.listener = null;
  watch.stop.mockClear();
  watch.throws = false;
});

afterEach(() => {
  cleanup();
});

describe("useDecisionsSwitch", () => {
  it("is unknown until main answers, then follows it, and is never on before that", () => {
    render(<Probe />);
    expect(seen.at(-1)).toBe("unknown/false");

    report({ state: "connecting" } as DecisionsStatus);
    expect(seen.at(-1)).toBe("on/true");

    report({ state: "off" } as DecisionsStatus);
    expect(seen.at(-1)).toBe("off/false");
  });

  it("starts unknown again once its last holder is gone", () => {
    const { unmount } = render(<Probe />);
    report({ state: "connecting" } as DecisionsStatus);
    unmount();
    expect(watch.stop).toHaveBeenCalledTimes(1);

    render(<Probe />);

    expect(seen.at(-1)).toBe("unknown/false");
  });

  it("reads as off when there is no bridge to ask", () => {
    watch.throws = true;

    render(<Probe />);

    expect(seen.at(-1)).toBe("off/false");
  });

  it("is read outside React as the view's watch last heard it, and unknown once nobody holds it", () => {
    expect(readDecisionsSwitch()).toBe("unknown");
    const { unmount } = render(<Probe />);
    report({ state: "connected" } as DecisionsStatus);
    expect(readDecisionsSwitch()).toBe("on");
    report({ state: "off" } as DecisionsStatus);
    expect(readDecisionsSwitch()).toBe("off");
    unmount();
    expect(readDecisionsSwitch()).toBe("unknown");
  });

  it("watches nothing and reads unknown while inactive", () => {
    function Inactive() {
      seen.push(useDecisionsSwitch(false));
      return null;
    }
    render(<Inactive />);
    expect(watch.listener).toBeNull();
    expect(seen.at(-1)).toBe("unknown");
  });
});
