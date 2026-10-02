// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// One Lucide glyph whose chunk fails the first time it is fetched, as it would
// offline; every other name loads as normal.
const flaky = vi.hoisted(() => ({ calls: 0 }));
vi.mock("lucide-react/dynamicIconImports", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, () => Promise<unknown>> }>();
  return {
    default: {
      ...actual.default,
      "hand-coins": () => {
        flaky.calls += 1;
        return flaky.calls === 1
          ? Promise.reject(new Error("chunk failed"))
          : actual.default["hand-coins"]!();
      },
    },
  };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import "@/components/PluginKit/PluginKit";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("kit icons after a failed load", () => {
  it("retries a glyph whose chunk failed and fills in the icon already drawn", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(createElement(kit.Icon, { name: "hand-coins", size: 16 }));
    const svg = () => container.querySelector("svg")!;

    await act(async () => {
      await vi.waitFor(() => expect(flaky.calls).toBe(1));
    });
    expect(svg().hasAttribute("data-kit-icon-loading")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      await vi.waitFor(() => expect(svg().hasAttribute("data-kit-icon-loading")).toBe(false));
    });
    expect(flaky.calls).toBe(2);
    expect(svg().childElementCount).toBeGreaterThan(0);
  });
});
