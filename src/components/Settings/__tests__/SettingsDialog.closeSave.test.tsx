// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const projectForm = vi.hoisted(() => ({ flush: vi.fn(async () => {}) }));
vi.mock("@/hooks/useProjectSettingsForm", () => ({
  useProjectSettingsForm: () => ({
    currentProject: null,
    projectIsLoading: false,
    flush: projectForm.flush,
    saveNow: async () => {},
  }),
}));
const hostList = vi.hoisted(() => ({ hosts: [] as unknown[] }));
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({ hosts: hostList.hosts }),
}));
vi.mock("../pluginSettingsSearch", () => ({ usePluginSettingsSearchIndex: () => [] }));
vi.mock("../GeneralTab", () => ({ GeneralTab: () => <p>General page</p> }));
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  appClient: { getVersionInfo: () => Promise.resolve({ appVersion: "0.0.0", arch: "arm64" }) },
}));

import { SettingsDialog } from "../SettingsDialog";
import { hostEnvDrafts, type HostEnvDraft } from "../Hosts/hostEnvDrafts";
import { getSettingsTabEntry } from "../settingsTabRegistry";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import { useSettingsTargetStore } from "@/store/settingsTargetStore";

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

beforeAll(async () => {
  // Slow Windows workers can spend the field wait on the cold tab import.
  const environmentTab = getSettingsTabEntry("environment");
  if (environmentTab?.importKind === "lazy") await environmentTab.importer();
});

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
    expect(screen.getAllByLabelText(/^Name of variable \d+$/)).toHaveLength(1);
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
    const badName = screen.getAllByLabelText<HTMLInputElement>(/^Name of variable \d+$/)[1]!;
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
    fireEvent.change(screen.getAllByLabelText(/^Name of variable \d+$/)[1]!, {
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
    fireEvent.change(screen.getByLabelText(/^Value of /), {
      target: { value: "2" },
    });

    await pressEscape();

    expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ GOOD: "2" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets a hide flush through without holding anything open", async () => {
    const onClose = await openOnEnvironment();
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    const badName = screen.getAllByLabelText(/^Name of variable \d+$/)[1]!;
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

describe("SettingsDialog close with an unsaved edit on another machine (#17208)", () => {
  const CONNECTED = {
    status: "connected",
    rttMs: 1,
    handshake: {
      version: "1.0.0",
      commit: "abc",
      protocolVersion: 1,
      platform: "linux",
      arch: "x64",
    },
  };
  const draft = (value: string): HostEnvDraft => ({
    rows: [{ id: "r1", key: "LANG", value }],
    base: { record: { LANG: "C" }, revision: "r-env" },
    movedUnder: false,
  });

  beforeEach(() => {
    hostList.hosts = [{ descriptor: { id: "host-b", name: "Host B" }, connection: CONNECTED }];
    window.electron = {
      ...window.electron,
      hostSettings: {
        read: vi.fn().mockResolvedValue({
          hostId: "host-b",
          hostName: "Host B",
          scope: "host",
          instanceId: "launch-1",
          unavailable: [],
          settings: [
            { key: "globalEnvironmentVariables", value: { LANG: "C" }, revision: "r-env" },
          ],
        }),
        update: vi.fn(),
      },
    };
  });

  afterEach(() => {
    hostList.hosts = [];
    hostEnvDrafts.clear();
    useSettingsTargetStore.getState().setHostId(null);
  });

  it("holds the close on a remaining host's edit when the first edit left was a removed host's", async () => {
    // host-a was removed while its edit was waiting, so it is no longer offered.
    hostEnvDrafts.set("host-a", draft("from A"));
    hostEnvDrafts.set("host-b", draft("C.UTF-8"));
    const onClose = await openOnEnvironment();

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(useSettingsTargetStore.getState().hostId).toBe("host-b");
    await screen.findByText("Save or discard these changes to close Settings");
    const values = screen
      .getAllByLabelText<HTMLInputElement>(/^Value of /)
      .map((input) => input.value);
    expect(values).toContain("C.UTF-8");
    expect(hostEnvDrafts.get("host-b")?.rows[0]?.value).toBe("C.UTF-8");
  });

  it("opens a fresh page on a host re-pointed while its page was showing", async () => {
    const held = "Save or discard these changes to close Settings";
    const shownValues = () =>
      screen.getAllByLabelText<HTMLInputElement>(/^Value of /).map((input) => input.value);
    hostEnvDrafts.set("host-b", draft("C.UTF-8"));
    const onClose = await openOnEnvironment();
    await pressEscape();
    await screen.findByText(held);

    // Twice over: each re-point is another machine, not only the first.
    for (const edit of ["POSIX", "en_US.UTF-8"]) {
      act(() => hostEnvDrafts.forget("host-b"));
      await waitFor(() => expect(screen.queryByText(held)).toBeNull());
      expect(shownValues()).not.toContain("C.UTF-8");
      expect(hostEnvDrafts.get("host-b")).toBeUndefined();

      // The fresh page keeps its own edit, which holds the close as before.
      const hostValue = screen
        .getAllByLabelText<HTMLInputElement>(/^Value of /)
        .find((input) => input.value === "C")!;
      fireEvent.change(hostValue, { target: { value: edit } });
      expect(hostEnvDrafts.get("host-b")?.rows[0]?.value).toBe(edit);
      await pressEscape();
      expect(onClose).not.toHaveBeenCalled();
      await screen.findByText(held);
    }

    act(() => hostEnvDrafts.forget("host-b"));
    await waitFor(() => expect(screen.queryByText(held)).toBeNull());
    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
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
    let finishProjectSave!: () => void;
    projectForm.flush.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishProjectSave = resolve))
    );
    const onClose = await openOnEnvironment();
    fireEvent.change(screen.getByLabelText(/^Value of /), {
      target: { value: "2" },
    });

    let answered = false;
    await act(async () => {
      void cacheView().then(() => {
        answered = true;
      });
    });

    expect(document.hidden).toBe(false);
    expect(window.electron.globalEnv.set).toHaveBeenCalledWith({ GOOD: "2" });
    expect(projectForm.flush).not.toHaveBeenCalled();

    await act(async () => finishEnvSave());
    expect(projectForm.flush).toHaveBeenCalledTimes(1);
    expect(answered).toBe(false);

    await act(async () => finishProjectSave());
    expect(answered).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("joins a close that is already saving rather than saving again", async () => {
    const finishEnvSave = deferEnvSave();
    const onClose = await openOnEnvironment();
    fireEvent.change(screen.getByLabelText(/^Value of /), {
      target: { value: "2" },
    });
    await pressEscape();
    expect(window.electron.globalEnv.set).toHaveBeenCalledTimes(1);

    let answered = false;
    await act(async () => {
      void cacheView().then(() => {
        answered = true;
      });
    });
    // The edge waits on the close's save rather than answering at once.
    expect(answered).toBe(false);

    await act(async () => finishEnvSave());

    expect(answered).toBe(true);
    expect(window.electron.globalEnv.set).toHaveBeenCalledTimes(1);
    expect(projectForm.flush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
