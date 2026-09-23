// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// jsdom ships no matchMedia; InlineStatusBanner reads it to honour reduced motion.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: { setColorVisionMode: vi.fn() },
}));

// Stub the DOM-writing layer so the real store still runs its side effect, but we
// can observe *which* mode was pushed to documentElement. That is the half of the
// rollback that matters: restoring JS state without re-running the filter swap
// would leave the user looking at colors the app won't boot with.
vi.mock("@/theme/applyAppTheme", () => ({
  applyAppThemeToRoot: vi.fn(),
  applyColorVisionMode: vi.fn(),
}));

import { appThemeClient } from "@/clients/appThemeClient";
import { applyColorVisionMode } from "@/theme/applyAppTheme";
import { useAppThemeStore } from "@/store/appThemeStore";
import { ColorVisionPicker } from "../ColorVisionPicker";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MODE_BY_LABEL: Record<string, string> = {
  Default: "default",
  "Red-green": "red-green",
  "Blue-yellow": "blue-yellow",
};
const renderedMode = () => {
  const checked = document.querySelector('[role="radiogroup"] [role="radio"][aria-checked="true"]');
  return MODE_BY_LABEL[checked?.textContent ?? ""] ?? null;
};
const storedMode = () => useAppThemeStore.getState().colorVisionMode;
const selectMode = (label: string) => act(() => screen.getByText(label).click());

beforeEach(() => {
  vi.mocked(appThemeClient.setColorVisionMode).mockReset();
  vi.mocked(applyColorVisionMode).mockClear();
  act(() => useAppThemeStore.setState({ colorVisionMode: "default" }));
});

describe("ColorVisionPicker persistence failures", () => {
  it("restores the last saved mode — in state and on the document — when the write is rejected", async () => {
    const write = deferred();
    vi.mocked(appThemeClient.setColorVisionMode).mockReturnValue(write.promise);

    render(<ColorVisionPicker />);
    selectMode("Red-green");

    // Optimistic: the new mode is applied before the write resolves.
    expect(renderedMode()).toBe("red-green");

    await act(async () => {
      write.reject(new Error("EACCES"));
      await write.promise.catch(() => {});
    });

    expect(storedMode()).toBe("default");
    expect(renderedMode()).toBe("default");
    // The rollback must go back through the store setter so the CVD filter is
    // re-applied, not just the JS value.
    expect(vi.mocked(applyColorVisionMode).mock.calls.at(-1)?.[1]).toBe("default");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("re-applies and re-persists the requested mode on Retry, clearing the error once it lands", async () => {
    const failed = deferred();
    vi.mocked(appThemeClient.setColorVisionMode).mockReturnValueOnce(failed.promise);

    render(<ColorVisionPicker />);
    selectMode("Blue-yellow");

    await act(async () => {
      failed.reject(new Error("disk full"));
      await failed.promise.catch(() => {});
    });
    expect(storedMode()).toBe("default");

    vi.mocked(appThemeClient.setColorVisionMode).mockResolvedValue(undefined);
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());

    // Retry re-applies the mode the user asked for, not the rolled-back one.
    expect(vi.mocked(appThemeClient.setColorVisionMode).mock.calls.at(-1)?.[0]).toBe("blue-yellow");
    expect(storedMode()).toBe("blue-yellow");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let a stale rejection roll back a newer mode that saved successfully", async () => {
    const stale = deferred();
    vi.mocked(appThemeClient.setColorVisionMode)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(undefined);

    render(<ColorVisionPicker />);
    selectMode("Red-green"); // in flight, will fail late
    await act(async () => screen.getByText("Blue-yellow").click()); // supersedes it, succeeds

    expect(storedMode()).toBe("blue-yellow");

    await act(async () => {
      stale.reject(new Error("late failure"));
      await stale.promise.catch(() => {});
    });

    // The superseded failure owns nothing: it must not drag the UI back to the
    // value that preceded it, which is no longer what is on disk.
    expect(storedMode()).toBe("blue-yellow");
    expect(renderedMode()).toBe("blue-yellow");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces the failure inline rather than leaving the successful-looking value in place", async () => {
    const write = deferred();
    vi.mocked(appThemeClient.setColorVisionMode).mockReturnValue(write.promise);

    const { container } = render(<ColorVisionPicker />);
    selectMode("Red-green");

    await act(async () => {
      write.reject(new Error("nope"));
      await write.promise.catch(() => {});
    });

    // The alert lives inside the component (an inline banner), not in a global
    // toast host, and it is the live region that announces to assistive tech.
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});
