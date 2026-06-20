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

  it("captures a dropped unsupported preferredAgentId as droppedPreferredAgentId (issue #8775)", async () => {
    const legacyBlob = JSON.stringify({
      state: { width: 420, preferredAgentId: "gemini" },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().preferredAgentId).toBeNull();
    expect(store.getState().droppedPreferredAgentId).toBe("gemini");
  });

  it("leaves droppedPreferredAgentId null when no preference was persisted (issue #8775)", async () => {
    const legacyBlob = JSON.stringify({
      state: { width: 420, preferredAgentId: null },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().droppedPreferredAgentId).toBeNull();
  });

  it("does not flag a non-built-in (user-defined / not-yet-loaded) preferredAgentId as dropped (issue #8775)", async () => {
    // The user agent registry loads asynchronously after this synchronous
    // rehydration, so a still-valid user-defined agent must NOT be treated as a
    // drop or it would false-banner on every restart.
    const legacyBlob = JSON.stringify({
      state: { width: 420, preferredAgentId: "my-custom-agent" },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().preferredAgentId).toBeNull();
    expect(store.getState().droppedPreferredAgentId).toBeNull();
  });

  it("setTerminal() clears droppedPreferredAgentId so the banner can't resurface after recovery (issue #8775)", async () => {
    const legacyBlob = JSON.stringify({
      state: { width: 420, preferredAgentId: "gemini" },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    expect(store.getState().droppedPreferredAgentId).toBe("gemini");

    store.getState().setTerminal("term-1", "claude", null);
    expect(store.getState().droppedPreferredAgentId).toBeNull();
  });

  it("clearDroppedPreferredAgent() clears the banner state without persisting it (issue #8775)", async () => {
    const legacyBlob = JSON.stringify({
      state: { width: 420, preferredAgentId: "gemini" },
    });
    const backing = installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    expect(store.getState().droppedPreferredAgentId).toBe("gemini");

    store.getState().clearDroppedPreferredAgent();
    expect(store.getState().droppedPreferredAgentId).toBeNull();

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    expect(written!).not.toContain("droppedPreferredAgentId");
  });

  it("setPreferredAgent() clears droppedPreferredAgentId (issue #8775)", async () => {
    const legacyBlob = JSON.stringify({
      state: { width: 420, preferredAgentId: "gemini" },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    expect(store.getState().droppedPreferredAgentId).toBe("gemini");

    store.getState().setPreferredAgent("claude");
    expect(store.getState().preferredAgentId).toBe("claude");
    expect(store.getState().droppedPreferredAgentId).toBeNull();
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
    vi.useFakeTimers();
    try {
      const legacyBlob = JSON.stringify({
        state: { width: 420, preferredAgentId: "gemini" },
      });
      const backing = installLocalStorage({ [STORAGE_KEY]: legacyBlob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setWidth(450);
      vi.advanceTimersByTime(400);

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
      expect(parsed.version).toBe(5);
      expect(parsed.state.width).toBe(450);
      expect(parsed.state.preferredAgentId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
      const backing = installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().dismissIntro();
      vi.advanceTimersByTime(400);

      expect(store.getState().introDismissed).toBe(true);

      const written = backing.get(STORAGE_KEY);
      expect(written).toBeDefined();
      const parsed: unknown = JSON.parse(written!);
      expect(parsed).toMatchObject({
        version: 5,
        state: { introDismissed: true },
      });
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
      const backing = installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setOpen(true);
      expect(store.getState().isOpen).toBe(true);
      vi.advanceTimersByTime(400);

      const written = backing.get(STORAGE_KEY);
      expect(written).toBeDefined();
      const parsed = JSON.parse(written!) as {
        version: number;
        state: Record<string, unknown>;
      };
      expect(parsed.version).toBe(5);
      expect(parsed.state).not.toHaveProperty("isOpen");
    } finally {
      vi.useRealTimers();
    }
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

  it("clearTerminal drops figures so a crash/hibernate teardown can't leak them into the next session (#9829)", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().addFigure({
      imageId: "img-1",
      figureNumber: 1,
      figureLabel: "image #1",
      url: "https://daintree.org/figure-1.png",
    });
    expect(store.getState().figures).toHaveLength(1);

    store.getState().clearTerminal();
    expect(store.getState().figures).toEqual([]);
  });

  it("conversationTouched is NOT persisted", async () => {
    vi.useFakeTimers();
    try {
      const backing = installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().markConversationStarted();
      vi.advanceTimersByTime(400);

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
    } finally {
      vi.useRealTimers();
    }
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
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});

        let mod = await import("../helpPanelStore");
        mod.useHelpPanelStore.getState().setHibernateSession("proj-a", {
          sessionId: "session-a",
          cwd: "/tmp/a",
          agentId: "claude",
        });
        vi.advanceTimersByTime(400);

        const written = backing.get(STORAGE_KEY);
        expect(written).toBeDefined();
        const parsed = JSON.parse(written!) as {
          version: number;
          state: { hibernateSessions: Record<string, unknown> };
        };
        expect(parsed.version).toBe(5);
        expect(parsed.state.hibernateSessions).toEqual({
          "proj-a": { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
        });

        vi.useRealTimers();
        vi.resetModules();
        mod = await import("../helpPanelStore");
        expect(mod.useHelpPanelStore.getState().hibernateSessions).toEqual({
          "proj-a": { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
        });
      } finally {
        vi.useRealTimers();
      }
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

    it("preserves empty-sessionId entries (resume-latest sentinel, #8787)", async () => {
      // sessionId: "" signals "graceful-shutdown capture missed — use the
      // agent's resume-latest flag on next open" (e.g. claude --continue).
      // Sanitization must NOT drop these.
      const blob = JSON.stringify({
        version: 3,
        state: {
          isOpen: false,
          width: 400,
          preferredAgentId: null,
          introDismissed: false,
          hibernateSessions: {
            "resume-latest-proj": { sessionId: "", cwd: "/tmp", agentId: "claude" },
          },
        },
      });
      installLocalStorage({ [STORAGE_KEY]: blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().hibernateSessions).toEqual({
        "resume-latest-proj": { sessionId: "", cwd: "/tmp", agentId: "claude" },
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

  describe("autoLaunchEnabled (#10699)", () => {
    it("starts false on a fresh install so opening the panel never auto-bills a session", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().autoLaunchEnabled).toBe(false);
    });

    it("defaults to false for a returning v4 user with a preferredAgentId set (no carve-out)", async () => {
      // The whole point of #10699: existing installs must NOT keep silently
      // auto-launching. A v4 blob has no autoLaunchEnabled field at all.
      const v4Blob = JSON.stringify({
        version: 4,
        state: { width: 400, preferredAgentId: "claude", introDismissed: true },
      });
      installLocalStorage({ [STORAGE_KEY]: v4Blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().preferredAgentId).toBe("claude");
      expect(store.getState().autoLaunchEnabled).toBe(false);
    });

    it("preserves autoLaunchEnabled: true from a persisted blob across rehydration", async () => {
      const blob = JSON.stringify({
        version: 5,
        state: { width: 400, preferredAgentId: "claude", autoLaunchEnabled: true },
      });
      installLocalStorage({ [STORAGE_KEY]: blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().autoLaunchEnabled).toBe(true);
    });

    it("falls back to false when persisted autoLaunchEnabled has a non-boolean type", async () => {
      const malformed = JSON.stringify({
        version: 5,
        state: { width: 400, preferredAgentId: null, autoLaunchEnabled: "true" },
      });
      installLocalStorage({ [STORAGE_KEY]: malformed });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().autoLaunchEnabled).toBe(false);
    });

    it("setAutoLaunchEnabled(true) records consent and persists it", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});

        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.getState().setAutoLaunchEnabled(true);
        expect(store.getState().autoLaunchEnabled).toBe(true);
        vi.advanceTimersByTime(400);

        const written = backing.get(STORAGE_KEY);
        expect(written).toBeDefined();
        const parsed = JSON.parse(written!) as {
          version: number;
          state: Record<string, unknown>;
        };
        expect(parsed.version).toBe(5);
        expect(parsed.state.autoLaunchEnabled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("setAutoLaunchEnabled(false) flips consent back off", async () => {
      const blob = JSON.stringify({
        version: 5,
        state: { width: 400, preferredAgentId: "claude", autoLaunchEnabled: true },
      });
      installLocalStorage({ [STORAGE_KEY]: blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      expect(store.getState().autoLaunchEnabled).toBe(true);

      store.getState().setAutoLaunchEnabled(false);
      expect(store.getState().autoLaunchEnabled).toBe(false);
    });
  });

  describe("activeFigureNumber (#9830)", () => {
    it("starts as null on a fresh install", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().activeFigureNumber).toBeNull();
    });

    it("setActiveFigureNumber updates the active figure", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setActiveFigureNumber(3);

      expect(store.getState().activeFigureNumber).toBe(3);

      store.getState().setActiveFigureNumber(null);
      expect(store.getState().activeFigureNumber).toBeNull();
    });

    it("clearFigures resets the active figure alongside the figures list", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().addFigure({
        imageId: "img-1",
        figureNumber: 1,
        figureLabel: "image #1",
        url: "https://daintree.org/a.png",
      });
      store.getState().setActiveFigureNumber(1);
      expect(store.getState().figures).toHaveLength(1);
      expect(store.getState().activeFigureNumber).toBe(1);

      store.getState().clearFigures();
      expect(store.getState().figures).toHaveLength(0);
      expect(store.getState().activeFigureNumber).toBeNull();
    });

    it("clearTerminal drops figures and the active figure (session-scoped reset)", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().addFigure({
        imageId: "img-1",
        figureNumber: 1,
        figureLabel: "image #1",
        url: "https://daintree.org/a.png",
      });
      store.getState().setActiveFigureNumber(1);
      expect(store.getState().figures).toHaveLength(1);
      expect(store.getState().activeFigureNumber).toBe(1);

      store.getState().clearTerminal();
      expect(store.getState().figures).toHaveLength(0);
      expect(store.getState().activeFigureNumber).toBeNull();
    });

    it("activeFigureNumber is NOT persisted", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});

        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.getState().setActiveFigureNumber(2);
        vi.advanceTimersByTime(400);

        const written = backing.get(STORAGE_KEY);
        expect(written).toBeDefined();
        const parsed = JSON.parse(written!) as {
          version: number;
          state: Record<string, unknown>;
        };
        expect(parsed.state).not.toHaveProperty("activeFigureNumber");
        expect(store.getState().activeFigureNumber).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
