// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
import { assistantSlotKey as slotKey } from "../../../shared/config/assistantSlots";
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

    store.getState().setTerminal(0, "term-1", "claude", null);
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
      expect(parsed.version).toBe(6);
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
        version: 6,
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
      expect(parsed.version).toBe(6);
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

    expect(store.getState().sessions[0]!.conversationTouched).toBe(false);
  });

  it("markConversationStarted sets conversationTouched to true", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted(0);

    expect(store.getState().sessions[0]!.conversationTouched).toBe(true);
  });

  it("markConversationStarted is idempotent (calling twice still yields true)", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted(0);
    store.getState().markConversationStarted(0);

    expect(store.getState().sessions[0]!.conversationTouched).toBe(true);
  });

  it("setTerminal resets conversationTouched to false", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted(0);
    expect(store.getState().sessions[0]!.conversationTouched).toBe(true);

    store.getState().setTerminal(0, "term-1", "claude", null);
    expect(store.getState().sessions[0]!.conversationTouched).toBe(false);
  });

  it("setTerminal initializes preferredAgentId from the bound agent when none is set", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    expect(store.getState().preferredAgentId).toBeNull();

    store.getState().setTerminal(0, "term-1", "codex", null);
    expect(store.getState().preferredAgentId).toBe("codex");
  });

  it("setTerminal preserves an explicit preferredAgentId across a re-bind (issue #8353)", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().setPreferredAgent("claude");

    // A live terminal re-binds (resume/reconnect) to a different agent —
    // the user's explicit choice must survive, not get clobbered.
    store.getState().setTerminal(0, "term-1", "codex", null);
    expect(store.getState().preferredAgentId).toBe("claude");
    expect(store.getState().sessions[0]!.agentId).toBe("codex");
  });

  it("clearTerminal resets conversationTouched to false", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted(0);
    expect(store.getState().sessions[0]!.conversationTouched).toBe(true);

    store.getState().clearTerminal(0);
    expect(store.getState().sessions[0]!.conversationTouched).toBe(false);
  });

  it("clearTerminal drops figures so a crash/hibernate teardown can't leak them into the next session (#9829)", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().addFigure(0, {
      imageId: "img-1",
      figureNumber: 1,
      figureLabel: "image #1",
      url: "https://daintree.org/figure-1.png",
    });
    expect(store.getState().sessions[0]!.figures).toHaveLength(1);

    store.getState().clearTerminal(0);
    expect(store.getState().sessions[0]!.figures).toEqual([]);
  });

  it("conversationTouched is NOT persisted", async () => {
    vi.useFakeTimers();
    try {
      const backing = installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().markConversationStarted(0);
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
      expect(store.getState().sessions[0]!.conversationTouched).toBe(true);
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

    expect(store.getState().sessions[0]!.conversationTouched).toBe(false);
  });

  // #12108. The lane axis the pre-lane cases above never had: they all describe
  // slot 0 and still pass unchanged, so these add what is genuinely new.
  describe("assistant lanes (#12108)", () => {
    it("openSlot takes the lowest free lane, focuses it, and refuses past the ceiling", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store, MAX_SLOTS } = await import("../helpPanelStore").then(
        async (m) => ({
          useHelpPanelStore: m.useHelpPanelStore,
          MAX_SLOTS: (await import("../../../shared/config/assistantSlots")).MAX_ASSISTANT_SLOTS,
        })
      );

      const opened: Array<number | null> = [];
      for (let i = 0; i < MAX_SLOTS + 1; i += 1) {
        opened.push(store.getState().openSlot());
      }

      // Slot 0 exists from the start, so the first call takes 1.
      expect(opened.slice(0, MAX_SLOTS - 1)).toEqual([1, 2].slice(0, MAX_SLOTS - 1));
      // Refuses rather than reusing a lane — reuse would displace a session the
      // user never named.
      expect(opened[opened.length - 1]).toBeNull();
      expect(store.getState().activeSlot).toBe(MAX_SLOTS - 1);
    });

    it("keeps lanes independent: writing one leaves its sibling untouched", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().openSlot();

      store.getState().setTerminal(0, "term-0", "claude", "sess-0");
      store.getState().setTerminal(1, "term-1", "codex", "sess-1");

      expect(store.getState().sessions[0]).toMatchObject({
        terminalId: "term-0",
        agentId: "claude",
        sessionId: "sess-0",
      });
      expect(store.getState().sessions[1]).toMatchObject({
        terminalId: "term-1",
        agentId: "codex",
        sessionId: "sess-1",
      });

      // Clearing one lane must not touch the other's terminal OR its figures.
      store.getState().addFigure(1, {
        imageId: "img-1",
        figureNumber: 1,
        figureLabel: "Figure 1",
        url: "https://daintree.org/a.png",
      });
      store.getState().clearTerminal(0);

      expect(store.getState().sessions[0]!.terminalId).toBeNull();
      expect(store.getState().sessions[1]!.terminalId).toBe("term-1");
      expect(store.getState().sessions[1]!.figures).toHaveLength(1);
    });

    it("closeSlot drops the lane and falls back to the lowest remaining one", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().openSlot();
      store.getState().setTerminal(0, "term-0", "claude", null);
      store.getState().setActiveSlot(1);

      store.getState().closeSlot(1);

      expect(store.getState().sessions[1]).toBeUndefined();
      expect(store.getState().activeSlot).toBe(0);
      expect(store.getState().sessions[0]!.terminalId).toBe("term-0");
    });

    it("never leaves the panel lane-less: closing the last lane resets slot 0", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setTerminal(0, "term-0", "claude", "sess-0");

      store.getState().closeSlot(0);

      // Slot 0 still exists, but empty — the panel has an empty state to show
      // rather than no lane at all.
      expect(store.getState().activeSlot).toBe(0);
      expect(store.getState().sessions[0]).toMatchObject({ terminalId: null, sessionId: null });
    });

    it("ignores writes to a lane the user already closed", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().openSlot();
      store.getState().closeSlot(1);

      // An in-flight launch resolving after its tab was closed must not
      // resurrect the lane.
      store.getState().setTerminal(1, "term-late", "claude", "sess-late");

      expect(store.getState().sessions[1]).toBeUndefined();
    });

    it("keeps each lane's hibernation entry separate", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store.getState().setHibernateSession("proj-1", 0, {
        sessionId: "s0",
        cwd: "/tmp/a",
        agentId: "claude",
      });
      store.getState().setHibernateSession("proj-1", 1, {
        sessionId: "s1",
        cwd: "/tmp/b",
        agentId: "claude",
      });
      store.getState().clearHibernateSession("proj-1", 0);

      expect(store.getState().hibernateSessions).toEqual({
        [slotKey("proj-1", 1)]: { sessionId: "s1", cwd: "/tmp/b", agentId: "claude" },
      });
    });

    it("migrates a v5 bare-projectId hibernation key onto slot 0", async () => {
      // Without this an upgrading user silently loses every resume token: the
      // old key would never be looked up again.
      installLocalStorage({
        "help-panel-storage": JSON.stringify({
          version: 5,
          state: {
            hibernateSessions: {
              "proj-legacy": { sessionId: "legacy-id", cwd: "/tmp/legacy", agentId: "claude" },
            },
          },
        }),
      });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().hibernateSessions).toEqual({
        [slotKey("proj-legacy", 0)]: {
          sessionId: "legacy-id",
          cwd: "/tmp/legacy",
          agentId: "claude",
        },
      });
    });
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
      store.getState().setHibernateSession("proj-1", 0, {
        sessionId: "abc-123",
        cwd: "/tmp/help",
        agentId: "claude",
      });

      expect(store.getState().hibernateSessions).toEqual({
        [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help", agentId: "claude" },
      });
    });

    it("setHibernateSession isolates entries by projectId", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setHibernateSession("proj-a", 0, {
        sessionId: "session-a",
        cwd: "/tmp/a",
        agentId: "claude",
      });
      store.getState().setHibernateSession("proj-b", 0, {
        sessionId: "session-b",
        cwd: "/tmp/b",
        agentId: "claude",
      });

      expect(store.getState().hibernateSessions).toEqual({
        [slotKey("proj-a", 0)]: { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
        [slotKey("proj-b", 0)]: { sessionId: "session-b", cwd: "/tmp/b", agentId: "claude" },
      });
    });

    it("clearHibernateSession removes only the named project entry", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setHibernateSession("proj-a", 0, {
        sessionId: "session-a",
        cwd: "/tmp/a",
        agentId: "claude",
      });
      store.getState().setHibernateSession("proj-b", 0, {
        sessionId: "session-b",
        cwd: "/tmp/b",
        agentId: "claude",
      });
      store.getState().clearHibernateSession("proj-a", 0);

      expect(store.getState().hibernateSessions).toEqual({
        [slotKey("proj-b", 0)]: { sessionId: "session-b", cwd: "/tmp/b", agentId: "claude" },
      });
    });

    it("clearHibernateSession on an unknown projectId is a no-op", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setHibernateSession("proj-a", 0, {
        sessionId: "session-a",
        cwd: "/tmp/a",
        agentId: "claude",
      });
      store.getState().clearHibernateSession("proj-unknown", 0);

      expect(store.getState().hibernateSessions).toEqual({
        [slotKey("proj-a", 0)]: { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
      });
    });

    it("persists hibernateSessions across rehydration", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});

        let mod = await import("../helpPanelStore");
        mod.useHelpPanelStore.getState().setHibernateSession("proj-a", 0, {
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
        expect(parsed.version).toBe(6);
        expect(parsed.state.hibernateSessions).toEqual({
          [slotKey("proj-a", 0)]: { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
        });

        vi.useRealTimers();
        vi.resetModules();
        mod = await import("../helpPanelStore");
        expect(mod.useHelpPanelStore.getState().hibernateSessions).toEqual({
          [slotKey("proj-a", 0)]: { sessionId: "session-a", cwd: "/tmp/a", agentId: "claude" },
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

  describe("cross-view write merge (#11351)", () => {
    type PersistedBlob = {
      version: number;
      state: {
        width: number;
        preferredAgentId: string | null;
        autoLaunchEnabled: boolean;
        introDismissed: boolean;
        hibernateSessions: Record<string, unknown>;
      };
    };

    it("a stale view's hibernate write does not drop a sibling view's session (disk read at flush)", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});
        const mod = await import("../helpPanelStore");

        // This view captures project A's session and flushes it to the shared partition.
        mod.useHelpPanelStore.getState().setHibernateSession("proj-a", 0, {
          sessionId: "a1",
          cwd: "/a",
          agentId: "claude",
        });
        vi.advanceTimersByTime(400);

        // This (stale) view updates project A again — enqueued, not yet flushed.
        mod.useHelpPanelStore.getState().setHibernateSession("proj-a", 0, {
          sessionId: "a2",
          cwd: "/a",
          agentId: "claude",
        });

        // A sibling view (project B) writes its own session DURING the debounce
        // window. The flush must read disk at flush time to preserve it.
        const disk = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        disk.state.hibernateSessions[slotKey("proj-b", 0)] = {
          sessionId: "b1",
          cwd: "/b",
          agentId: "claude",
        };
        backing.set(STORAGE_KEY, JSON.stringify(disk));

        vi.advanceTimersByTime(400);

        const written = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        expect(written.state.hibernateSessions).toEqual({
          [slotKey("proj-a", 0)]: { sessionId: "a2", cwd: "/a", agentId: "claude" },
          [slotKey("proj-b", 0)]: { sessionId: "b1", cwd: "/b", agentId: "claude" },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("a fresh view (null baseline) defers untouched fields to a sibling instead of clobbering with defaults", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});
        const mod = await import("../helpPanelStore");

        // Before this freshly-hydrated view writes anything, a sibling view has
        // already populated the shared blob with a session and NON-DEFAULT
        // preferences (so a defaults-clobbering merge would be caught).
        backing.set(
          STORAGE_KEY,
          JSON.stringify({
            version: 6,
            state: {
              width: 500,
              preferredAgentId: null,
              autoLaunchEnabled: true,
              introDismissed: true,
              hibernateSessions: {
                [slotKey("proj-b", 0)]: { sessionId: "b1", cwd: "/b", agentId: "claude" },
              },
            },
          })
        );

        // This view's first write changes only its own field (width). Its null
        // baseline must NOT let its default hibernateSessions {} / preferences
        // clobber the sibling's blob.
        mod.useHelpPanelStore.getState().setWidth(600);
        vi.advanceTimersByTime(400);

        const written = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        expect(written.state.width).toBe(600);
        expect(written.state.autoLaunchEnabled).toBe(true);
        expect(written.state.introDismissed).toBe(true);
        expect(written.state.hibernateSessions).toEqual({
          [slotKey("proj-b", 0)]: { sessionId: "b1", cwd: "/b", agentId: "claude" },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("a stale write does not clobber a sibling's width when the baseline held an out-of-range value", async () => {
      vi.useFakeTimers();
      try {
        // Legacy/hand-edited blob with an out-of-range width. Hydration clamps it
        // to HELP_PANEL_MAX_WIDTH in memory; the raw baseline must canonicalize to
        // the same clamped value so an unrelated write doesn't read it as an edit.
        const backing = installLocalStorage({
          [STORAGE_KEY]: JSON.stringify({
            version: 6,
            state: {
              width: HELP_PANEL_MAX_WIDTH + 1000,
              preferredAgentId: null,
              autoLaunchEnabled: false,
              introDismissed: false,
              hibernateSessions: {},
            },
          }),
        });
        const mod = await import("../helpPanelStore");
        // Sanity: hydration clamped the in-memory width.
        expect(mod.useHelpPanelStore.getState().width).toBe(HELP_PANEL_MAX_WIDTH);

        // A sibling sets an in-range width on disk.
        const disk = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        disk.state.width = 500;
        backing.set(STORAGE_KEY, JSON.stringify(disk));

        // An unrelated write (a hibernate capture) must not clobber the sibling's width.
        mod.useHelpPanelStore.getState().setHibernateSession("proj-x", 0, {
          sessionId: "x1",
          cwd: "/x",
          agentId: "claude",
        });
        vi.advanceTimersByTime(400);

        const written = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        expect(written.state.width).toBe(500);
        expect(written.state.hibernateSessions).toEqual({
          [slotKey("proj-x", 0)]: { sessionId: "x1", cwd: "/x", agentId: "claude" },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resurrect a session a sibling deleted that this view still holds unchanged", async () => {
      vi.useFakeTimers();
      try {
        // Hydrate a blob holding two sessions, so both live in this view's memory.
        const backing = installLocalStorage({
          [STORAGE_KEY]: JSON.stringify({
            version: 6,
            state: {
              width: HELP_PANEL_DEFAULT_WIDTH,
              preferredAgentId: null,
              autoLaunchEnabled: false,
              introDismissed: false,
              hibernateSessions: {
                [slotKey("proj-a", 0)]: { sessionId: "a1", cwd: "/a", agentId: "claude" },
                [slotKey("proj-b", 0)]: { sessionId: "b1", cwd: "/b", agentId: "claude" },
              },
            },
          }),
        });
        const mod = await import("../helpPanelStore");

        // A sibling deletes proj-b on disk.
        const disk = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        delete disk.state.hibernateSessions[slotKey("proj-b", 0)];
        backing.set(STORAGE_KEY, JSON.stringify(disk));

        // This view writes an unrelated field; it still carries proj-b in memory,
        // but must not resurrect the sibling's deletion.
        mod.useHelpPanelStore.getState().setWidth(500);
        vi.advanceTimersByTime(400);

        const written = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        expect(written.state.hibernateSessions).toEqual({
          [slotKey("proj-a", 0)]: { sessionId: "a1", cwd: "/a", agentId: "claude" },
        });
        expect(written.state.width).toBe(500);
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves the empty-sessionId resume-latest sentinel through a merge write (#8787)", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});
        const mod = await import("../helpPanelStore");

        // A sibling captured a session for its own project.
        backing.set(
          STORAGE_KEY,
          JSON.stringify({
            version: 6,
            state: {
              width: HELP_PANEL_DEFAULT_WIDTH,
              preferredAgentId: null,
              autoLaunchEnabled: false,
              introDismissed: false,
              hibernateSessions: {
                [slotKey("proj-b", 0)]: { sessionId: "b1", cwd: "/b", agentId: "claude" },
              },
            },
          })
        );

        // This view captures a resume-latest sentinel (empty sessionId) for its project.
        mod.useHelpPanelStore.getState().setHibernateSession("proj-a", 0, {
          sessionId: "",
          cwd: "/a",
          agentId: "claude",
        });
        vi.advanceTimersByTime(400);

        const written = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        expect(written.state.hibernateSessions).toEqual({
          [slotKey("proj-a", 0)]: { sessionId: "", cwd: "/a", agentId: "claude" },
          [slotKey("proj-b", 0)]: { sessionId: "b1", cwd: "/b", agentId: "claude" },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resurrect a sibling's session when this view clears its own", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});
        const mod = await import("../helpPanelStore");

        mod.useHelpPanelStore.getState().setHibernateSession("proj-a", 0, {
          sessionId: "a1",
          cwd: "/a",
          agentId: "claude",
        });
        vi.advanceTimersByTime(400);

        const disk = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        disk.state.hibernateSessions[slotKey("proj-b", 0)] = {
          sessionId: "b1",
          cwd: "/b",
          agentId: "claude",
        };
        backing.set(STORAGE_KEY, JSON.stringify(disk));

        // Clearing this view's own project must not resurrect it, and must keep B.
        mod.useHelpPanelStore.getState().clearHibernateSession("proj-a", 0);
        vi.advanceTimersByTime(400);

        const written = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        expect(written.state.hibernateSessions).toEqual({
          [slotKey("proj-b", 0)]: { sessionId: "b1", cwd: "/b", agentId: "claude" },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("a stale scalar write does not clobber a sibling's preferredAgentId change", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});
        const mod = await import("../helpPanelStore");

        mod.useHelpPanelStore.getState().setWidth(500);
        vi.advanceTimersByTime(400);

        // A sibling view changes preferredAgentId directly on the shared blob.
        const disk = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        disk.state.preferredAgentId = "codex";
        backing.set(STORAGE_KEY, JSON.stringify(disk));

        // This stale view changes only width; its in-memory preferredAgentId is still null.
        mod.useHelpPanelStore.getState().setWidth(600);
        vi.advanceTimersByTime(400);

        const written = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        expect(written.state.width).toBe(600);
        expect(written.state.preferredAgentId).toBe("codex");
      } finally {
        vi.useRealTimers();
      }
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
        version: 6,
        state: { width: 400, preferredAgentId: "claude", autoLaunchEnabled: true },
      });
      installLocalStorage({ [STORAGE_KEY]: blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().autoLaunchEnabled).toBe(true);
    });

    it("falls back to false when persisted autoLaunchEnabled has a non-boolean type", async () => {
      const malformed = JSON.stringify({
        version: 6,
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
        expect(parsed.version).toBe(6);
        expect(parsed.state.autoLaunchEnabled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("setAutoLaunchEnabled(false) flips consent back off", async () => {
      const blob = JSON.stringify({
        version: 6,
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

      expect(store.getState().sessions[0]!.activeFigureNumber).toBeNull();
    });

    it("setActiveFigureNumber updates the active figure", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setActiveFigureNumber(0, 3);

      expect(store.getState().sessions[0]!.activeFigureNumber).toBe(3);

      store.getState().setActiveFigureNumber(0, null);
      expect(store.getState().sessions[0]!.activeFigureNumber).toBeNull();
    });

    it("clearFigures resets the active figure alongside the figures list", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().addFigure(0, {
        imageId: "img-1",
        figureNumber: 1,
        figureLabel: "image #1",
        url: "https://daintree.org/a.png",
      });
      store.getState().setActiveFigureNumber(0, 1);
      expect(store.getState().sessions[0]!.figures).toHaveLength(1);
      expect(store.getState().sessions[0]!.activeFigureNumber).toBe(1);

      store.getState().clearFigures(0);
      expect(store.getState().sessions[0]!.figures).toHaveLength(0);
      expect(store.getState().sessions[0]!.activeFigureNumber).toBeNull();
    });

    it("clearTerminal drops figures and the active figure (session-scoped reset)", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().addFigure(0, {
        imageId: "img-1",
        figureNumber: 1,
        figureLabel: "image #1",
        url: "https://daintree.org/a.png",
      });
      store.getState().setActiveFigureNumber(0, 1);
      expect(store.getState().sessions[0]!.figures).toHaveLength(1);
      expect(store.getState().sessions[0]!.activeFigureNumber).toBe(1);

      store.getState().clearTerminal(0);
      expect(store.getState().sessions[0]!.figures).toHaveLength(0);
      expect(store.getState().sessions[0]!.activeFigureNumber).toBeNull();
    });

    it("activeFigureNumber is NOT persisted", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});

        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.getState().setActiveFigureNumber(0, 2);
        vi.advanceTimersByTime(400);

        const written = backing.get(STORAGE_KEY);
        expect(written).toBeDefined();
        const parsed = JSON.parse(written!) as {
          version: number;
          state: Record<string, unknown>;
        };
        expect(parsed.state).not.toHaveProperty("activeFigureNumber");
        expect(store.getState().sessions[0]!.activeFigureNumber).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
