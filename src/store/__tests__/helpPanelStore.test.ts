// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HELP_PANEL_DEFAULT_WIDTH,
  HELP_PANEL_MAX_WIDTH,
  HELP_PANEL_MIN_WIDTH,
} from "../helpPanelStore";

describe("helpPanelStore persistence migration", () => {
  const STORAGE_KEY = "help-panel-storage";
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );

  function installLocalStorage(initial: Record<string, string>): Map<string, string> {
    const backing = new Map<string, string>(Object.entries(initial));
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
          backing.set(key, value);
        },
        removeItem: (key: string) => {
          backing.delete(key);
        },
      },
      configurable: true,
      writable: true,
    });
    return backing;
  }

  function restoreLocalStorage(): void {
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
      return;
    }
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rehydrates a legacy unversioned blob and preserves an assistant-supported preferredAgentId", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        width: 500,
        preferredAgentId: "claude",
      },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().width).toBe(500);
    expect(store.getState().preferredAgentId).toBe("claude");
  });

  it("clamps out-of-range legacy width via the existing merge callback", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        width: HELP_PANEL_MAX_WIDTH + 1000,
        preferredAgentId: null,
      },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().width).toBe(HELP_PANEL_MAX_WIDTH);
  });

  it("falls back to defaults when nothing is persisted", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().width).toBe(HELP_PANEL_DEFAULT_WIDTH);
    expect(store.getState().width).toBeGreaterThanOrEqual(HELP_PANEL_MIN_WIDTH);
  });

  it("clears a legacy preferredAgentId for an agent without assistant wiring (issue #6612)", async () => {
    const legacyBlob = JSON.stringify({
      state: { width: 420, preferredAgentId: "gemini" },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().preferredAgentId).toBeNull();
    expect(store.getState().width).toBe(420);
  });

  it("preserves a v0 preferredAgentId when migrating to v1 if the agent is supported", async () => {
    const v0Blob = JSON.stringify({
      version: 0,
      state: { width: 420, preferredAgentId: "claude" },
    });
    installLocalStorage({ [STORAGE_KEY]: v0Blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().preferredAgentId).toBe("claude");
  });

  it("clears a v0 preferredAgentId when migrating to v1 if the agent is unsupported", async () => {
    const v0Blob = JSON.stringify({
      version: 0,
      state: { width: 420, preferredAgentId: "codex" },
    });
    installLocalStorage({ [STORAGE_KEY]: v0Blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().preferredAgentId).toBeNull();
  });

  it("writes version: 2 with a cleared preferredAgentId after rehydrating an unsupported v0 agent", async () => {
    const legacyBlob = JSON.stringify({
      state: { width: 420, preferredAgentId: "gemini" },
    });
    const backing = installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().setWidth(450);

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      version: number;
      state: {
        isOpen: boolean;
        width: number;
        preferredAgentId: string | null;
        introDismissed: boolean;
      };
    };
    expect(parsed.version).toBe(2);
    expect(parsed.state.width).toBe(450);
    expect(parsed.state.preferredAgentId).toBeNull();
  });

  it("migrates a v0 blob to v1 with introDismissed defaulted to false", async () => {
    const v0Blob = JSON.stringify({
      version: 0,
      state: { width: 400, preferredAgentId: "claude" },
    });
    installLocalStorage({ [STORAGE_KEY]: v0Blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().introDismissed).toBe(false);
    expect(store.getState().preferredAgentId).toBe("claude");
  });

  it("preserves introDismissed: true from a v1 blob across rehydration", async () => {
    const v1Blob = JSON.stringify({
      version: 1,
      state: { width: 400, preferredAgentId: null, introDismissed: true },
    });
    installLocalStorage({ [STORAGE_KEY]: v1Blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().introDismissed).toBe(true);
  });

  it("starts with introDismissed: false on a fresh install", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().introDismissed).toBe(false);
  });

  it("falls back to false when persisted introDismissed has a non-boolean type", async () => {
    const malformed = JSON.stringify({
      version: 1,
      state: { width: 400, preferredAgentId: null, introDismissed: "true" },
    });
    installLocalStorage({ [STORAGE_KEY]: malformed });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().introDismissed).toBe(false);
  });

  it("dismissIntro() sets introDismissed: true and persists it", async () => {
    const backing = installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().dismissIntro();

    expect(store.getState().introDismissed).toBe(true);

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed: unknown = JSON.parse(written!);
    expect(parsed).toMatchObject({
      version: 2,
      state: { introDismissed: true },
    });
  });

  it("defaults isOpen to false when migrating a v1 blob without it (issue #6619)", async () => {
    const v1Blob = JSON.stringify({
      version: 1,
      state: { width: 400, preferredAgentId: "claude", introDismissed: true },
    });
    installLocalStorage({ [STORAGE_KEY]: v1Blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().preferredAgentId).toBe("claude");
    expect(store.getState().introDismissed).toBe(true);
  });

  it("preserves isOpen: true from a v2 blob across rehydration", async () => {
    const v2Blob = JSON.stringify({
      version: 2,
      state: { isOpen: true, width: 400, preferredAgentId: null, introDismissed: false },
    });
    installLocalStorage({ [STORAGE_KEY]: v2Blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().isOpen).toBe(true);
  });

  it("falls back to false when persisted isOpen has a non-boolean type", async () => {
    const malformed = JSON.stringify({
      version: 2,
      state: { isOpen: "yes", width: 400, preferredAgentId: null, introDismissed: false },
    });
    installLocalStorage({ [STORAGE_KEY]: malformed });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().isOpen).toBe(false);
  });

  it("setOpen(true) persists isOpen to localStorage", async () => {
    const backing = installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().setOpen(true);

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      version: number;
      state: { isOpen: boolean };
    };
    expect(parsed.version).toBe(2);
    expect(parsed.state.isOpen).toBe(true);
  });

  it("starts with isOpen: false on a fresh install", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().isOpen).toBe(false);
  });
});
