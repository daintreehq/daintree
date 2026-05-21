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
      state: { width: 420, preferredAgentId: "gemini" },
    });
    installLocalStorage({ [STORAGE_KEY]: v0Blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().preferredAgentId).toBeNull();
  });

  it("writes the current version with a cleared preferredAgentId after rehydrating an unsupported v0 agent", async () => {
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
        width: number;
        preferredAgentId: string | null;
        introDismissed: boolean;
      };
    };
    expect(parsed.version).toBe(4);
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
      version: 4,
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

  it("starts hidden even when a legacy blob persisted isOpen: true", async () => {
    const v3Blob = JSON.stringify({
      version: 3,
      state: { isOpen: true, width: 400, preferredAgentId: null, introDismissed: false },
    });
    installLocalStorage({ [STORAGE_KEY]: v3Blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().isOpen).toBe(false);
  });

  it("starts hidden when persisted isOpen has a non-boolean type", async () => {
    const malformed = JSON.stringify({
      version: 2,
      state: { isOpen: "yes", width: 400, preferredAgentId: null, introDismissed: false },
    });
    installLocalStorage({ [STORAGE_KEY]: malformed });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().isOpen).toBe(false);
  });

  it("setOpen(true) changes runtime state but does not persist restart-open state", async () => {
    const backing = installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().setOpen(true);
    expect(store.getState().isOpen).toBe(true);

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      version: number;
      state: Record<string, unknown>;
    };
    expect(parsed.version).toBe(4);
    expect(parsed.state).not.toHaveProperty("isOpen");
  });

  it("starts with isOpen: false on a fresh install", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().isOpen).toBe(false);
  });

  it("starts with conversationTouched: false on a fresh install", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().conversationTouched).toBe(false);
  });

  it("markConversationStarted sets conversationTouched to true", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted();

    expect(store.getState().conversationTouched).toBe(true);
  });

  it("markConversationStarted is idempotent (calling twice still yields true)", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted();
    store.getState().markConversationStarted();

    expect(store.getState().conversationTouched).toBe(true);
  });

  it("setTerminal resets conversationTouched to false", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted();
    expect(store.getState().conversationTouched).toBe(true);

    store.getState().setTerminal("term-1", "claude", null);
    expect(store.getState().conversationTouched).toBe(false);
  });

  it("setTerminal initializes preferredAgentId from the bound agent when none is set", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    expect(store.getState().preferredAgentId).toBeNull();

    store.getState().setTerminal("term-1", "codex", null);
    expect(store.getState().preferredAgentId).toBe("codex");
  });

  it("setTerminal preserves an explicit preferredAgentId across a re-bind (issue #8353)", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().setPreferredAgent("claude");

    // A live terminal re-binds (resume/reconnect) to a different agent —
    // the user's explicit choice must survive, not get clobbered.
    store.getState().setTerminal("term-1", "codex", null);
    expect(store.getState().preferredAgentId).toBe("claude");
    expect(store.getState().agentId).toBe("codex");
  });

  it("clearTerminal resets conversationTouched to false", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted();
    expect(store.getState().conversationTouched).toBe(true);

    store.getState().clearTerminal();
    expect(store.getState().conversationTouched).toBe(false);
  });

  it("conversationTouched is NOT persisted", async () => {
    const backing = installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted();

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      version: number;
      state: Record<string, unknown>;
    };
    // conversationTouched is excluded from the persisted blob
    expect(parsed.state).not.toHaveProperty("conversationTouched");
    // The field is still true in the store
    expect(store.getState().conversationTouched).toBe(true);
  });

  it("conversationTouched defaults to false after rehydration regardless of persisted blob", async () => {
    // Simulate a (hypothetical) blob that somehow got conversationTouched injected
    const blob = JSON.stringify({
      version: 2,
      state: {
        isOpen: false,
        width: 400,
        preferredAgentId: null,
        introDismissed: false,
        conversationTouched: true,
      },
    });
    installLocalStorage({ [STORAGE_KEY]: blob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().conversationTouched).toBe(false);
  });

  describe("hibernateSessions", () => {
    it("starts as an empty record on a fresh install", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().hibernateSessions).toEqual({});
    });

    it("setHibernateSession adds an entry keyed by projectId", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setHibernateSession("proj-1", {
        sessionId: "abc-123",
        cwd: "/tmp/help",
        agentId: "claude",
      });

      expect(store.getState().hibernateSessions).toEqual({
        "proj-1": { sessionId: "abc-123", cwd: "/tmp/help", agentId: "claude" },
      });
    });

    it("setHibernateSession isolates entries by projectId", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setHibernateSession("proj-a", {
        sessionId: "session-a",
        cwd: "/tmp/a",
        agentId: "claude",
      });
      store.getState().setHibernateSession("proj-b", {
        sessionId: "session-b",
        cwd: "/tmp/b",
        agentId: "claude",
      });

      expect(store.getState().hibernateSessions).toEqual({
        "proj-a": { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
        "proj-b": { sessionId: "session-b", cwd: "/tmp/b", agentId: "claude" },
      });
    });

    it("clearHibernateSession removes only the named project entry", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setHibernateSession("proj-a", {
        sessionId: "session-a",
        cwd: "/tmp/a",
        agentId: "claude",
      });
      store.getState().setHibernateSession("proj-b", {
        sessionId: "session-b",
        cwd: "/tmp/b",
        agentId: "claude",
      });
      store.getState().clearHibernateSession("proj-a");

      expect(store.getState().hibernateSessions).toEqual({
        "proj-b": { sessionId: "session-b", cwd: "/tmp/b", agentId: "claude" },
      });
    });

    it("clearHibernateSession on an unknown projectId is a no-op", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setHibernateSession("proj-a", {
        sessionId: "session-a",
        cwd: "/tmp/a",
        agentId: "claude",
      });
      store.getState().clearHibernateSession("proj-unknown");

      expect(store.getState().hibernateSessions).toEqual({
        "proj-a": { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
      });
    });

    it("persists hibernateSessions across rehydration", async () => {
      const backing = installLocalStorage({});

      let mod = await import("../helpPanelStore");
      mod.useHelpPanelStore.getState().setHibernateSession("proj-a", {
        sessionId: "session-a",
        cwd: "/tmp/a",
        agentId: "claude",
      });

      const written = backing.get(STORAGE_KEY);
      expect(written).toBeDefined();
      const parsed = JSON.parse(written!) as {
        version: number;
        state: { hibernateSessions: Record<string, unknown> };
      };
      expect(parsed.version).toBe(4);
      expect(parsed.state.hibernateSessions).toEqual({
        "proj-a": { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
      });

      vi.resetModules();
      mod = await import("../helpPanelStore");
      expect(mod.useHelpPanelStore.getState().hibernateSessions).toEqual({
        "proj-a": { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
      });
    });

    it("rejects malformed entries during rehydration (missing sessionId/cwd/agentId)", async () => {
      const blob = JSON.stringify({
        version: 3,
        state: {
          isOpen: false,
          width: 400,
          preferredAgentId: null,
          introDismissed: false,
          hibernateSessions: {
            "good-proj": { sessionId: "abc", cwd: "/tmp", agentId: "claude" },
            "no-session": { cwd: "/tmp", agentId: "claude" },
            "no-cwd": { sessionId: "abc", agentId: "claude" },
            "no-agent": { sessionId: "abc", cwd: "/tmp" },
            "empty-session": { sessionId: "", cwd: "/tmp", agentId: "claude" },
            "wrong-types": { sessionId: 1, cwd: 2, agentId: 3 },
          },
        },
      });
      installLocalStorage({ [STORAGE_KEY]: blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().hibernateSessions).toEqual({
        "good-proj": { sessionId: "abc", cwd: "/tmp", agentId: "claude" },
      });
    });

    it("falls back to empty record when persisted hibernateSessions is not an object", async () => {
      const blob = JSON.stringify({
        version: 3,
        state: {
          isOpen: false,
          width: 400,
          preferredAgentId: null,
          introDismissed: false,
          hibernateSessions: "not-an-object",
        },
      });
      installLocalStorage({ [STORAGE_KEY]: blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().hibernateSessions).toEqual({});
    });

    it("starts with empty hibernateSessions when migrating from v2 (no field)", async () => {
      const v2Blob = JSON.stringify({
        version: 2,
        state: {
          isOpen: false,
          width: 400,
          preferredAgentId: "claude",
          introDismissed: true,
        },
      });
      installLocalStorage({ [STORAGE_KEY]: v2Blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().hibernateSessions).toEqual({});
      // Other fields still load correctly
      expect(store.getState().preferredAgentId).toBe("claude");
      expect(store.getState().introDismissed).toBe(true);
    });
  });
});
