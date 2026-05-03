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

  it("writes version: 1 with a cleared preferredAgentId after rehydrating an unsupported v0 agent", async () => {
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
      state: { width: number; preferredAgentId: string | null };
    };
    expect(parsed.version).toBe(1);
    expect(parsed.state.width).toBe(450);
    expect(parsed.state.preferredAgentId).toBeNull();
  });
});
