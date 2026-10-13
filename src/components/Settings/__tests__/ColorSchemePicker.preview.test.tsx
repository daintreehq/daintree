// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { BUILT_IN_SCHEMES, DEFAULT_SCHEME_ID } from "@/config/terminalColorSchemes";
import { BUILT_IN_APP_SCHEMES, relativeLuminance } from "@shared/theme";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";

vi.mock("@/clients/terminalConfigClient", () => ({
  terminalConfigClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    importColorScheme: vi.fn().mockResolvedValue({ ok: false }),
  },
}));

import { terminalConfigClient } from "@/clients/terminalConfigClient";
import {
  ColorSchemePicker,
  __resetSchemePersistenceForTests,
  resolveSchemeForPreview,
  schemeTone,
} from "../ColorSchemePicker";

describe("terminal scheme tone", () => {
  it("puts every light-listed scheme on a brighter background than every dark-listed one", () => {
    const luminance = (bg: string | undefined) => relativeLuminance(bg!);
    const light = BUILT_IN_SCHEMES.filter((s) => schemeTone(s) === "light");
    const dark = BUILT_IN_SCHEMES.filter((s) => schemeTone(s) === "dark");
    expect(light.length).toBeGreaterThan(0);
    expect(dark.length).toBeGreaterThan(0);
    const dimmestLight = Math.min(...light.map((s) => luminance(s.colors.background)));
    const brightestDark = Math.max(...dark.map((s) => luminance(s.colors.background)));
    expect(dimmestLight).toBeGreaterThan(brightestDark);
  });
});

describe("Match app theme preview", () => {
  const match = BUILT_IN_SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID)!;

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "paints %s's own terminal background, as the terminals do",
    (id, appScheme) => {
      const preview = resolveSchemeForPreview(match, id);
      const expected = appScheme.tokens["terminal-background"];
      if (!expected) return;
      expect(preview.colors.background?.toLowerCase()).toBe(expected.toLowerCase());
    }
  );
});

let pendingRaf: Array<{ handle: number; cb: FrameRequestCallback }> = [];
let nextHandle = 0;
const flushRaf = () => {
  act(() => {
    const pending = pendingRaf;
    pendingRaf = [];
    for (const entry of pending) entry.cb(0);
  });
};

describe("ColorSchemePicker hover preview", () => {
  beforeEach(() => {
    pendingRaf = [];
    nextHandle = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      nextHandle += 1;
      pendingRaf.push({ handle: nextHandle, cb });
      return nextHandle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      pendingRaf = pendingRaf.filter((entry) => entry.handle !== handle);
    });

    useTerminalColorSchemeStore.setState({
      selectedSchemeId: DEFAULT_SCHEME_ID,
      customSchemes: [],
      recentSchemeIds: [],
      previewSchemeId: null,
    });
    useAppThemeStore.setState({ selectedSchemeId: "daintree" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useTerminalColorSchemeStore.setState({ previewSchemeId: null });
  });

  it("sets previewSchemeId in the store on pointer enter", () => {
    render(<ColorSchemePicker error={null} onError={() => {}} />);

    const draculaCard = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;
    fireEvent.pointerEnter(draculaCard);

    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");
  });

  it("clears previewSchemeId on pointer leave after rAF flush", () => {
    render(<ColorSchemePicker error={null} onError={() => {}} />);

    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);

    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");
    flushRaf();
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
  });

  it("clears previewSchemeId when the picker unmounts mid-preview", () => {
    const { unmount } = render(<ColorSchemePicker error={null} onError={() => {}} />);
    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;
    fireEvent.pointerEnter(card);
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");

    unmount();
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
  });

  it("keyboard focus mirrors pointer preview behavior", () => {
    render(<ColorSchemePicker error={null} onError={() => {}} />);
    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;

    fireEvent.focus(card);
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");

    fireEvent.blur(card);
    flushRaf();
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
  });

  it("commit via click clears the preview override", () => {
    render(<ColorSchemePicker error={null} onError={() => {}} />);
    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;

    fireEvent.pointerEnter(card);
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");

    fireEvent.click(card);
    expect(useTerminalColorSchemeStore.getState().selectedSchemeId).toBe("dracula");
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
  });

  it("announces the currently previewed scheme via aria-live", () => {
    const { container } = render(<ColorSchemePicker error={null} onError={() => {}} />);
    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;

    fireEvent.pointerEnter(card);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/Previewing:/);

    fireEvent.pointerLeave(card);
    flushRaf();
    expect(live?.textContent).toBe("");
  });
});

function deferred() {
  let reject!: (reason: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ColorSchemePicker persistence", () => {
  const selected = () => useTerminalColorSchemeStore.getState().selectedSchemeId;
  const pick = (name: string) => act(() => screen.getByRole("option", { name }).click());

  beforeEach(() => {
    __resetSchemePersistenceForTests();
    vi.mocked(terminalConfigClient.setColorScheme).mockReset();
    useTerminalColorSchemeStore.setState({
      selectedSchemeId: DEFAULT_SCHEME_ID,
      customSchemes: [],
      recentSchemeIds: [],
      previewSchemeId: null,
    });
    useAppThemeStore.setState({ selectedSchemeId: "daintree" });
  });

  afterEach(cleanup);

  it("rolls back to what is on disk, never to an unsaved optimistic choice", async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(terminalConfigClient.setColorScheme)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onError = vi.fn();
    render(<ColorSchemePicker error={null} onError={onError} />);

    pick("Dracula");
    pick("Monokai");
    expect(selected()).toBe("monokai");

    await act(async () => {
      first.reject(new Error("EACCES"));
      await first.promise.catch(() => {});
    });
    // A superseded failure neither rolls back nor raises a banner.
    expect(selected()).toBe("monokai");
    expect(onError).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String) })
    );

    await act(async () => {
      second.reject(new Error("EACCES"));
      await second.promise.catch(() => {});
    });
    expect(selected()).toBe(DEFAULT_SCHEME_ID);
    expect(onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Couldn't save color scheme" })
    );
  });
});
