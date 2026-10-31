// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projectForm = vi.hoisted(() => ({ flush: vi.fn(async () => {}) }));
vi.mock("@/hooks/useProjectSettingsForm", () => ({
  useProjectSettingsForm: () => ({
    currentProject: null,
    projectIsLoading: false,
    flush: projectForm.flush,
    saveNow: async () => {},
  }),
}));
vi.mock("@/components/Hosts/hostList", () => ({ useHostList: () => ({ hosts: [] }) }));
vi.mock("../pluginSettingsSearch", () => ({ usePluginSettingsSearchIndex: () => [] }));
vi.mock("../GeneralTab", () => ({ GeneralTab: () => <p>General page</p> }));
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  appClient: { getVersionInfo: () => Promise.resolve({ appVersion: "0.0.0", arch: "arm64" }) },
}));

import { SettingsDialog } from "../SettingsDialog";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";

// jsdom has neither; the dialog preloads tabs at idle and measures its scroll shadows.
vi.stubGlobal("requestIdleCallback", () => 0);
vi.stubGlobal("cancelIdleCallback", () => {});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

beforeEach(() => {
  projectForm.flush.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      ...window.electron,
      globalEnv: {
        get: vi.fn().mockResolvedValue({ GOOD: "1" }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
});

async function openOnEnvironment() {
  const onClose = vi.fn();
  render(<SettingsDialog isOpen onClose={onClose} defaultTab="environment" />);
  await waitFor(() => {
    expect(screen.getAllByLabelText("Environment variable name")).toHaveLength(1);
  });
  return onClose;
}

function pressEscape() {
  return act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });
}

function panel(tab: string) {
  return document.getElementById(`settings-panel-${tab}`)!;
}

describe("SettingsDialog close with a draft that didn't save", () => {
  it("stays open on the page that failed, with focus on the field in error", async () => {
    const onClose = await openOnEnvironment();
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    const badName = screen.getAllByLabelText<HTMLInputElement>("Environment variable name")[1]!;
    fireEvent.change(badName, { target: { value: "1BAD" } });

    // Leave the page, so the close has to bring it back.
    await act(async () => {
      fireEvent.click(document.getElementById("settings-tab-general")!);
    });
    expect(panel("environment").classList.contains("hidden")).toBe(true);

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(panel("environment").classList.contains("hidden")).toBe(false);
    expect(document.activeElement).toBe(badName);
    expect(badName.getAttribute("aria-invalid")).toBe("true");
    expect(badName.value).toBe("1BAD");
    expect(window.electron.globalEnv.set).not.toHaveBeenCalled();
  });

  it("closes once the draft is discarded", async () => {
    const onClose = await openOnEnvironment();
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    fireEvent.change(screen.getAllByLabelText("Environment variable name")[1]!, {
      target: { value: "1BAD" },
    });

    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.electron.globalEnv.set).not.toHaveBeenCalled();
  });

  it("saves a valid draft and closes, as before", async () => {
    const onClose = await openOnEnvironment();
    fireEvent.change(screen.getByLabelText("Environment variable value"), {
      target: { value: "2" },
    });

    await pressEscape();

    expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ GOOD: "2" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets a hide flush through without holding anything open", async () => {
    const onClose = await openOnEnvironment();
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    const badName = screen.getAllByLabelText("Environment variable name")[1]!;
    fireEvent.change(badName, { target: { value: "1BAD" } });
    await act(async () => {
      fireEvent.click(document.getElementById("settings-tab-general")!);
    });
    // Unflagged until something tries to save it.
    expect(badName.getAttribute("aria-invalid")).not.toBe("true");

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } finally {
      hidden.mockRestore();
    }

    // The hide flushed the page, and that is all: nothing closes or navigates.
    expect(badName.getAttribute("aria-invalid")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
    expect(panel("environment").classList.contains("hidden")).toBe(true);
    expect(window.electron.globalEnv.set).not.toHaveBeenCalled();
  });
});

describe("SettingsDialog when main caches its project view (#15633)", () => {
  // Mirrors preload: a cached edge runs every registered flusher, and main is
  // answered once they have all settled. The document never goes hidden.
  let flushers: Set<() => unknown>;
  const cacheView = () => Promise.allSettled(Array.from(flushers, (flush) => flush()));

  beforeEach(() => {
    __resetProjectViewCacheStateForTests();
    flushers = new Set();
    window.electron = {
      ...window.electron,
      app: {
        ...window.electron.app,
        isViewCached: () => false,
        onViewCached: () => () => {},
        onViewWarmActivated: () => () => {},
        onViewRevealed: () => () => {},
        onViewCachedFlush: (callback: () => unknown) => {
          const flush = () => callback();
          flushers.add(flush);
          return () => flushers.delete(flush);
        },
      },
    };
  });

  afterEach(() => __resetProjectViewCacheStateForTests());

  function deferEnvSave() {
    let finish!: () => void;
    vi.mocked(window.electron.globalEnv.set).mockImplementation(
      () => new Promise<void>((resolve) => (finish = () => resolve()))
    );
    return () => finish();
  }

  it("saves the draft, then the project form, before main is told it can freeze", async () => {
    const finishEnvSave = deferEnvSave();
    const onClose = await openOnEnvironment();
    fireEvent.change(screen.getByLabelText("Environment variable value"), {
      target: { value: "2" },
    });

    let answered = false;
    let edge!: Promise<unknown>;
    await act(async () => {
      edge = cacheView().then(() => {
        answered = true;
      });
    });

    expect(document.hidden).toBe(false);
    expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ GOOD: "2" });
    expect(projectForm.flush).not.toHaveBeenCalled();
    expect(answered).toBe(false);

    await act(async () => {
      finishEnvSave();
      await edge;
    });

    expect(projectForm.flush).toHaveBeenCalledTimes(1);
    expect(answered).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("joins a close that is already saving rather than saving again", async () => {
    const finishEnvSave = deferEnvSave();
    const onClose = await openOnEnvironment();
    fireEvent.change(screen.getByLabelText("Environment variable value"), {
      target: { value: "2" },
    });
    await pressEscape();
    expect(window.electron.globalEnv.set).toHaveBeenCalledTimes(1);

    let edge!: Promise<unknown>;
    await act(async () => {
      edge = cacheView();
    });
    await act(async () => {
      finishEnvSave();
      await edge;
    });

    expect(window.electron.globalEnv.set).toHaveBeenCalledTimes(1);
    expect(projectForm.flush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
