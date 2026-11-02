// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP_PANEL_DEFAULT_WIDTH, HELP_PANEL_MAX_WIDTH } from "../helpPanelStore";
import { assistantSlotKey as slotKey } from "../../../shared/config/assistantSlots";

const agentDefaultsClientMock = vi.hoisted(() => ({
  set: vi.fn<(patch: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
}));
vi.mock("@/clients/agentDefaultsClient", () => ({ agentDefaultsClient: agentDefaultsClientMock }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

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
    agentDefaultsClientMock.set.mockReset();
    agentDefaultsClientMock.set.mockResolvedValue({});
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("ignores a persisted preferredAgentId — the assistant agent is the host's (#13345)", async () => {
    const legacyBlob = JSON.stringify({
      version: 6,
      state: { width: 500, preferredAgentId: "claude" },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useHelpPanelStore: store } = await import("../helpPanelStore");

    expect(store.getState().width).toBe(500);
    expect(store.getState().preferredAgentId).toBeNull();
    expect(store.getState().hostAssistantAgentId).toBeNull();
    expect(store.getState().droppedPreferredAgentId).toBeNull();
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

  describe("host assistant agent mirror (#13345)", () => {
    const installedOnly =
      (...installed: string[]) =>
      () => ({ hasRealData: true, isInstalled: (id: string) => installed.includes(id) });

    it("launches the host's choice when it's a supported agent", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store.getState().syncHostAssistantAgent("claude", null);

      expect(store.getState().preferredAgentId).toBe("claude");
      expect(store.getState().droppedPreferredAgentId).toBeNull();
    });

    it("explains a built-in that's no longer an assistant backend (issue #8775)", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store.getState().syncHostAssistantAgent("gemini", null);

      expect(store.getState().preferredAgentId).toBeNull();
      expect(store.getState().droppedPreferredAgentId).toBe("gemini");
      expect(store.getState().hostAssistantAgentId).toBe("gemini");
    });

    it("holds back a user-defined agent without a banner until its registry loads (issue #8775)", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store.getState().syncHostAssistantAgent("my-custom-agent", null);

      expect(store.getState().preferredAgentId).toBeNull();
      expect(store.getState().droppedPreferredAgentId).toBeNull();
    });

    it("drops a choice whose CLI isn't installed on the host, keeping the host's value", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store.getState().syncHostAssistantAgent("claude", installedOnly("codex")());

      expect(store.getState().preferredAgentId).toBeNull();
      expect(store.getState().droppedPreferredAgentId).toBe("claude");
      expect(store.getState().hostAssistantAgentId).toBe("claude");
      expect(agentDefaultsClientMock.set).not.toHaveBeenCalled();
    });

    it("doesn't count an agent as uninstalled before a real availability probe", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store
        .getState()
        .syncHostAssistantAgent("claude", { hasRealData: false, isInstalled: () => false });

      expect(store.getState().preferredAgentId).toBe("claude");
      expect(store.getState().droppedPreferredAgentId).toBeNull();
    });

    it("restores the choice once its CLI is installed", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store.getState().syncHostAssistantAgent("claude", installedOnly()());
      store.getState().syncHostAssistantAgent("claude", installedOnly("claude")());

      expect(store.getState().preferredAgentId).toBe("claude");
      expect(store.getState().droppedPreferredAgentId).toBeNull();
    });

    it("never queues a session switch from a host change", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store.getState().syncHostAssistantAgent("claude", null);
      store.getState().syncHostAssistantAgent("codex", null);

      expect(store.getState().agentSwitchRequest).toBeNull();
    });

    it("setTerminal() clears the banner so a re-sync can't resurface it after recovery (issue #8775)", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().syncHostAssistantAgent("gemini", null);
      expect(store.getState().droppedPreferredAgentId).toBe("gemini");

      store.getState().setTerminal(0, "term-1", "claude", null);
      store.getState().syncHostAssistantAgent("gemini", null);

      expect(store.getState().droppedPreferredAgentId).toBeNull();
    });

    it("clearDroppedPreferredAgent() dismisses the banner for good, without persisting it (issue #8775)", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.getState().syncHostAssistantAgent("gemini", null);

        store.getState().clearDroppedPreferredAgent();
        store.getState().syncHostAssistantAgent("gemini", null);
        vi.advanceTimersByTime(400);

        expect(store.getState().droppedPreferredAgentId).toBeNull();
        const written = backing.get(STORAGE_KEY);
        expect(written).toBeDefined();
        expect(written!).not.toContain("droppedPreferredAgentId");
        expect(written!).not.toContain("dismissedDroppedAgentId");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("setPreferredAgent (#8353, #13345)", () => {
    it("saves the pick on the host, clears the banner and queues a switch for this view", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().syncHostAssistantAgent("gemini", null);

      store.getState().setPreferredAgent("claude");

      expect(store.getState().preferredAgentId).toBe("claude");
      expect(store.getState().hostAssistantAgentId).toBe("claude");
      expect(store.getState().droppedPreferredAgentId).toBeNull();
      expect(store.getState().agentSwitchRequest).toMatchObject({ agentId: "claude" });
      await Promise.resolve();
      await Promise.resolve();
      expect(agentDefaultsClientMock.set).toHaveBeenCalledWith({ assistantAgentId: "claude" });
    });

    it("gives every pick its own request, even for the same agent", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      store.getState().setPreferredAgent("claude");
      const first = store.getState().agentSwitchRequest!.id;
      store.getState().setPreferredAgent("claude");

      expect(store.getState().agentSwitchRequest!.id).not.toBe(first);
    });

    it("queues no switch when the caller launches the pick itself", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setPreferredAgent("codex");

      store.getState().setPreferredAgent("claude", { switchSession: false });

      expect(store.getState().agentSwitchRequest).toBeNull();
    });

    it("clearing the agent drops a pending switch and saves an explicit null", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setPreferredAgent("claude");

      store.getState().setPreferredAgent(null);
      await Promise.resolve();
      await Promise.resolve();

      expect(store.getState().agentSwitchRequest).toBeNull();
      expect(agentDefaultsClientMock.set).toHaveBeenLastCalledWith({ assistantAgentId: null });
    });

    it("rolls a failed save back to the host's value", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().syncHostAssistantAgent("codex", null);
      agentDefaultsClientMock.set.mockRejectedValueOnce(new Error("link down"));

      store.getState().setPreferredAgent("claude");
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(store.getState().preferredAgentId).toBe("codex");
      expect(store.getState().hostAssistantAgentId).toBe("codex");
      expect(store.getState().agentSwitchRequest).toBeNull();
    });

    it("rolls back to what the host holds, not to an earlier pick that also failed", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().syncHostAssistantAgent("codex", null);
      agentDefaultsClientMock.set.mockRejectedValue(new Error("link down"));

      store.getState().setPreferredAgent("claude");
      store.getState().setPreferredAgent("gemini");
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(store.getState().hostAssistantAgentId).toBe("codex");
      expect(store.getState().preferredAgentId).toBe("codex");
    });

    it("keeps a value the host confirmed by push even if the save then fails", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().syncHostAssistantAgent("codex", null);
      let rejectSave: (error: Error) => void = () => {};
      agentDefaultsClientMock.set.mockReturnValueOnce(
        new Promise((_resolve, reject) => (rejectSave = reject))
      );

      store.getState().setPreferredAgent("claude");
      await Promise.resolve();
      // Another window's identical pick reaches the host first.
      store.getState().syncHostAssistantAgent("claude", null);
      rejectSave(new Error("link down"));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(store.getState().preferredAgentId).toBe("claude");
    });

    it("doesn't take an availability refresh as the host's word", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().syncHostAssistantAgent("codex", null);
      let rejectSave: (error: Error) => void = () => {};
      agentDefaultsClientMock.set.mockReturnValueOnce(
        new Promise((_resolve, reject) => (rejectSave = reject))
      );

      store.getState().setPreferredAgent("claude");
      await Promise.resolve();
      store.getState().refreshAssistantAvailability({ hasRealData: true, isInstalled: () => true });
      expect(store.getState().preferredAgentId).toBe("claude");
      rejectSave(new Error("link down"));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(store.getState().preferredAgentId).toBe("codex");
    });

    it("clearAgentSwitchRequest() only clears the request it names", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setPreferredAgent("codex");
      const stale = store.getState().agentSwitchRequest!.id;
      store.getState().setPreferredAgent("claude");

      store.getState().clearAgentSwitchRequest(stale);
      expect(store.getState().agentSwitchRequest).toMatchObject({ agentId: "claude" });

      store.getState().clearAgentSwitchRequest(store.getState().agentSwitchRequest!.id);
      expect(store.getState().agentSwitchRequest).toBeNull();
    });
  });

  it("writes v7 without a preference from memory, carrying a v6 one from disk until it's deleted", async () => {
    vi.useFakeTimers();
    try {
      const backing = installLocalStorage({
        [STORAGE_KEY]: JSON.stringify({
          version: 6,
          state: { width: 420, preferredAgentId: "claude" },
        }),
      });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().setPreferredAgent("codex");
      store.getState().setWidth(450);
      vi.advanceTimersByTime(400);

      const parsed: unknown = JSON.parse(backing.get(STORAGE_KEY)!);
      // The machine's own value, untouched until a local window has moved it.
      expect(parsed).toMatchObject({
        version: 8,
        state: { width: 450, preferredAgentId: "claude" },
      });

      // Migration deletes it; a later write must not put anything back.
      backing.set(STORAGE_KEY, JSON.stringify({ version: 7, state: { width: 450 } }));
      store.getState().setWidth(460);
      vi.advanceTimersByTime(400);

      const after: unknown = JSON.parse(backing.get(STORAGE_KEY)!);
      expect(after).toMatchObject({ state: { width: 460 } });
      expect(after).not.toHaveProperty("state.preferredAgentId");
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
        version: 8,
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
      expect(parsed.version).toBe(8);
      expect(parsed.state).not.toHaveProperty("isOpen");
    } finally {
      vi.useRealTimers();
    }
  });

  it("setTerminal resets conversationTouched to false", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().markConversationStarted(0);
    expect(store.getState().sessions[0]!.conversationTouched).toBe(true);

    store.getState().setTerminal(0, "term-1", "claude", null);
    expect(store.getState().sessions[0]!.conversationTouched).toBe(false);
  });

  it("setTerminal never seeds the host's preference from a launch (#13345)", async () => {
    installLocalStorage({});

    const { useHelpPanelStore: store } = await import("../helpPanelStore");
    store.getState().setTerminal(0, "term-1", "codex", null);

    expect(store.getState().preferredAgentId).toBeNull();
    expect(store.getState().hostAssistantAgentId).toBeNull();
    expect(agentDefaultsClientMock.set).not.toHaveBeenCalled();
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
  describe("global assistant selection (#14454)", () => {
    const target = {
      hostId: "local",
      scope: { kind: "global" as const },
      terminalId: "g1",
      incarnation: 2,
    };

    it("shows the global run over the lanes and comes back to the lane it left", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().openSlot();
      expect(store.getState().activeSlot).toBe(1);
      store.getState().selectGlobal(target);
      expect(store.getState()).toMatchObject({
        globalSelected: true,
        globalTarget: target,
        activeSlot: 1,
      });
      // Choosing the lane already behind it still leaves the global tab.
      store.getState().setActiveSlot(1);
      expect(store.getState()).toMatchObject({ globalSelected: false, globalTarget: null });
    });

    it("leaves the global tab for a newly opened lane, and never persists the choice", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().selectGlobal();
      expect(store.getState().globalTarget).toBeNull();
      store.getState().openSlot();
      expect(store.getState().globalSelected).toBe(false);
      store.getState().selectGlobal(target);
      const persisted: unknown = store.persist.getOptions().partialize?.(store.getState());
      expect(persisted).not.toHaveProperty("globalSelected");
      expect(persisted).not.toHaveProperty("globalTarget");
    });

    describe("a window's panel carried over a project switch (#16099)", () => {
      it("shows Global in one update, without asking for the keyboard", async () => {
        installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.getState().openSlot();
        store.getState().requestFocus();
        const focusRequest = store.getState().focusRequest;
        const seen: Array<{ isOpen: boolean; globalSelected: boolean }> = [];
        const off = store.subscribe((s) =>
          seen.push({ isOpen: s.isOpen, globalSelected: s.globalSelected })
        );

        store.getState().applyWindowGlobalPanel({ showing: true, target });
        off();

        // Never an open panel on a project lane, which that lane could launch into.
        expect(seen).toEqual([{ isOpen: true, globalSelected: true }]);
        // The lane behind it is kept to come back to.
        expect(store.getState()).toMatchObject({
          globalTarget: target,
          activeSlot: 1,
          focusRequest,
          globalFocusHandledThrough: focusRequest,
        });
        const persisted: unknown = store.persist.getOptions().partialize?.(store.getState());
        expect(persisted).not.toHaveProperty("globalFocusHandledThrough");
        expect(persisted).not.toHaveProperty("isOpen");
      });

      it("leaves a panel already showing the same run untouched", async () => {
        installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.getState().selectGlobal(target);
        store.getState().setOpen(true);
        store.getState().requestFocus();
        const before = store.getState();

        store.getState().applyWindowGlobalPanel({ showing: true, target: { ...target } });

        expect(store.getState()).toBe(before);
        // A successor run, or following whichever runs, is another target, and is taken.
        store.getState().applyWindowGlobalPanel({
          showing: true,
          target: { ...target, incarnation: 3 },
        });
        expect(store.getState().globalTarget).toMatchObject({ incarnation: 3 });
        store.getState().applyWindowGlobalPanel({ showing: true, target: null });
        expect(store.getState().globalTarget).toBeNull();
        const following = store.getState();
        store.getState().applyWindowGlobalPanel({ showing: true, target: null });
        expect(store.getState()).toBe(following);
      });

      it("closes Global the window closed, keeping it selected for the next open", async () => {
        installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.getState().selectGlobal(target);
        store.getState().setOpen(true);

        store.getState().applyWindowGlobalPanel({ showing: false, target: null });

        expect(store.getState()).toMatchObject({
          isOpen: false,
          globalSelected: true,
          globalTarget: target,
        });
      });

      it("never opens or closes this project's own lane, and ignores no record", async () => {
        installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.getState().setOpen(true);
        const laneOpen = store.getState();

        store.getState().applyWindowGlobalPanel({ showing: false, target: null });
        expect(store.getState()).toBe(laneOpen);
        store.getState().applyWindowGlobalPanel(null);
        expect(store.getState()).toBe(laneOpen);

        store.getState().setOpen(false);
        const closed = store.getState();
        store.getState().applyWindowGlobalPanel({ showing: false, target: null });
        expect(store.getState()).toBe(closed);
      });
    });
  });

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

    it("closeSlot drops the lane and falls back to the one before it when none follows", async () => {
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

    it("closeSlot selects the following lane when the selected one closes between two", async () => {
      installLocalStorage({});
      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().openSlot();
      store.getState().openSlot();
      store.getState().setActiveSlot(1);

      store.getState().closeSlot(1);

      // Its neighbour, as a browser tab strip does, not the lowest remaining slot.
      expect(store.getState().activeSlot).toBe(2);
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
        expect(parsed.version).toBe(8);
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
        [slotKey("good-proj", 0)]: { sessionId: "abc", cwd: "/tmp", agentId: "claude" },
      });
    });

    // Resume needs the same agent, and the retired assistant CLI never
    // launches again, so its entries are dropped rather than carried forever.
    it("drops entries for the retired assistant CLI during rehydration", async () => {
      const blob = JSON.stringify({
        version: 7,
        state: {
          width: 400,
          introDismissed: false,
          hibernateSessions: {
            [slotKey("live-proj", 0)]: { sessionId: "abc", cwd: "/tmp", agentId: "codex" },
            [slotKey("retired-proj", 0)]: {
              sessionId: "def",
              cwd: "/tmp",
              agentId: "daintree-assistant",
            },
          },
        },
      });
      installLocalStorage({ [STORAGE_KEY]: blob });

      const { useHelpPanelStore: store } = await import("../helpPanelStore");

      expect(store.getState().hibernateSessions).toEqual({
        [slotKey("live-proj", 0)]: { sessionId: "abc", cwd: "/tmp", agentId: "codex" },
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
        [slotKey("resume-latest-proj", 0)]: { sessionId: "", cwd: "/tmp", agentId: "claude" },
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
      expect(store.getState().introDismissed).toBe(true);
    });
  });

  describe("cross-view write merge (#11351)", () => {
    type PersistedBlob = {
      version: number;
      state: {
        width: number;
        preferredAgentId?: string | null;
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
            version: 8,
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

    it("a sibling's pre-v8 auto-launch flag is written back as false, never carried as consent (#14976)", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});
        const mod = await import("../helpPanelStore");
        backing.set(
          STORAGE_KEY,
          JSON.stringify({ version: 7, state: { width: 500, autoLaunchEnabled: true } })
        );

        mod.useHelpPanelStore.getState().setWidth(600);
        vi.advanceTimersByTime(400);

        const written: unknown = JSON.parse(backing.get(STORAGE_KEY)!);
        expect(written).toMatchObject({
          version: 8,
          state: { width: 600, autoLaunchEnabled: false },
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

    it("keeps this machine's legacy preference through a sibling's write until migration deletes it", async () => {
      vi.useFakeTimers();
      try {
        const backing = installLocalStorage({});
        const mod = await import("../helpPanelStore");

        mod.useHelpPanelStore.getState().setWidth(500);
        vi.advanceTimersByTime(400);

        // A pre-#13345 build (or a sibling still holding a v6 blob) left the
        // machine's assistant agent on disk. A remote-bound view writing first
        // must not erase it before a local window can move it to the host.
        const disk = JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
        disk.state.preferredAgentId = "codex";
        backing.set(STORAGE_KEY, JSON.stringify(disk));

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

      expect(store.getState().autoLaunchEnabled).toBe(false);
    });

    it.each([5, 6, 7])(
      "drops a v%i autoLaunchEnabled: true, which any Start click recorded (#14976)",
      async (version) => {
        vi.useFakeTimers();
        try {
          const blob = JSON.stringify({
            version,
            state: { width: 400, introDismissed: true, autoLaunchEnabled: true },
          });
          const backing = installLocalStorage({ [STORAGE_KEY]: blob });

          const { useHelpPanelStore: store } = await import("../helpPanelStore");

          expect(store.getState().autoLaunchEnabled).toBe(false);
          // Only the recorded consent goes; the rest of the blob survives.
          expect(store.getState().width).toBe(400);
          expect(store.getState().introDismissed).toBe(true);

          // And it reaches disk, so the next view to load reads false too.
          vi.advanceTimersByTime(400);
          const written: unknown = JSON.parse(backing.get(STORAGE_KEY)!);
          expect(written).toMatchObject({ version: 8, state: { autoLaunchEnabled: false } });
          vi.resetModules();
          const reloaded = await import("../helpPanelStore");
          expect(reloaded.useHelpPanelStore.getState().autoLaunchEnabled).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it("preserves autoLaunchEnabled: true from a v8 blob across rehydration", async () => {
      const blob = JSON.stringify({
        version: 8,
        state: { width: 400, autoLaunchEnabled: true },
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
        expect(parsed.version).toBe(8);
        expect(parsed.state.autoLaunchEnabled).toBe(true);

        // And back off, persisted the same way (#14976).
        store.getState().setAutoLaunchEnabled(false);
        vi.advanceTimersByTime(400);
        const off: unknown = JSON.parse(backing.get(STORAGE_KEY)!);
        expect(off).toMatchObject({ state: { autoLaunchEnabled: false } });
      } finally {
        vi.useRealTimers();
      }
    });

    describe("another view's change (#14976)", () => {
      const blob = (autoLaunchEnabled: unknown, width = 300, version = 8) =>
        JSON.stringify({ version, state: { autoLaunchEnabled, width } });
      // A sibling's write as this view hears it: disk already holds `next`.
      function siblingWrites(backing: Map<string, string>, prev: string | null, next: string) {
        backing.set(STORAGE_KEY, next);
        window.dispatchEvent(
          new StorageEvent("storage", { key: STORAGE_KEY, oldValue: prev, newValue: next })
        );
      }

      it("follows it, as the shared storage holds it now", async () => {
        const backing = installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.setState({ autoLaunchEnabled: true, width: 500 });

        siblingWrites(backing, blob(true), blob(false));
        expect(store.getState().autoLaunchEnabled).toBe(false);
        // Nothing else is taken from the event.
        expect(store.getState().width).toBe(500);

        // Off then on again, heard late: the first event can't undo the second.
        backing.set(STORAGE_KEY, blob(true));
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: STORAGE_KEY,
            oldValue: blob(true),
            newValue: blob(false),
          })
        );
        expect(store.getState().autoLaunchEnabled).toBe(true);
      });

      it("ignores a sibling's write of something else, which still carries the old flag", async () => {
        const backing = installLocalStorage({ [STORAGE_KEY]: blob(true) });
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        expect(store.getState().autoLaunchEnabled).toBe(true);

        // Turned off here, still inside the write debounce, when a sibling
        // writes its width with disk's `true` in it.
        store.getState().setAutoLaunchEnabled(false);
        siblingWrites(backing, blob(true), blob(true, 640));

        expect(store.getState().autoLaunchEnabled).toBe(false);
      });

      it("ignores a sibling's first write onto an empty key, which only carries the default", async () => {
        const backing = installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");

        // Turned on here, still inside the write debounce, when a sibling's
        // first-ever write lands with the default in it.
        store.getState().setAutoLaunchEnabled(true);
        siblingWrites(backing, null, blob(false, 640));

        expect(store.getState().autoLaunchEnabled).toBe(true);
      });

      it("never turns it on from a pre-v8 blob, a non-boolean, or another key", async () => {
        const backing = installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        expect(store.getState().autoLaunchEnabled).toBe(false);

        siblingWrites(backing, blob(false), blob(true, 300, 7));
        expect(store.getState().autoLaunchEnabled).toBe(false);
        siblingWrites(backing, blob(false), blob("true"));
        expect(store.getState().autoLaunchEnabled).toBe(false);
        siblingWrites(backing, blob(false), "{not json");
        expect(store.getState().autoLaunchEnabled).toBe(false);

        backing.set(STORAGE_KEY, blob(true));
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "other-key",
            oldValue: blob(false),
            newValue: blob(true),
          })
        );
        expect(store.getState().autoLaunchEnabled).toBe(false);
      });

      it("never leaves it on from a non-boolean either", async () => {
        const backing = installLocalStorage({});
        const { useHelpPanelStore: store } = await import("../helpPanelStore");
        store.setState({ autoLaunchEnabled: true });

        siblingWrites(backing, blob(true), blob("false"));
        // A malformed value isn't a choice: it changes nothing here.
        expect(store.getState().autoLaunchEnabled).toBe(true);
        siblingWrites(backing, blob(true), blob(true, 300, 7));
        // A pre-v8 blob is never consent, whatever it says.
        expect(store.getState().autoLaunchEnabled).toBe(false);
      });
    });
  });

  describe("activeFigureNumber (#9830)", () => {
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

    it("a newly arrived figure takes over as current from an earlier reference", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      const figure = (n: number) => ({
        imageId: `img-${n}`,
        figureNumber: n,
        figureLabel: `image #${n}`,
        url: `https://daintree.org/${n}.png`,
      });
      store.getState().addFigure(0, figure(1));
      store.getState().setActiveFigureNumber(0, 1);

      // A replayed push of the same figure is not an arrival.
      store.getState().addFigure(0, figure(1));
      expect(store.getState().sessions[0]!.activeFigureNumber).toBe(1);

      store.getState().addFigure(0, figure(2));
      expect(store.getState().sessions[0]!.activeFigureNumber).toBeNull();
    });

    it("activateFigure issues a fresh request each time, even for the current figure", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().activateFigure(0, 2, false);
      const first = store.getState().sessions[0]!.figureRequest;
      store.getState().activateFigure(0, 2, true);
      const second = store.getState().sessions[0]!.figureRequest;

      expect(store.getState().sessions[0]!.activeFigureNumber).toBe(2);
      expect(first?.open).toBe(false);
      expect(second?.open).toBe(true);
      expect(second!.seq).not.toBe(first!.seq);

      store.getState().clearFigureRequest(0);
      expect(store.getState().sessions[0]!.figureRequest).toBeUndefined();
      // Clearing the request leaves the figure current.
      expect(store.getState().sessions[0]!.activeFigureNumber).toBe(2);
    });

    it("clearFigures and clearTerminal drop a pending figure request", async () => {
      installLocalStorage({});

      const { useHelpPanelStore: store } = await import("../helpPanelStore");
      store.getState().activateFigure(0, 1, true);
      store.getState().clearFigures(0);
      expect(store.getState().sessions[0]!.figureRequest).toBeUndefined();

      store.getState().activateFigure(0, 1, true);
      store.getState().clearTerminal(0);
      expect(store.getState().sessions[0]!.figureRequest).toBeUndefined();
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

describe("selectHasRoomForSession (#13442)", () => {
  const lane = (overrides: { terminalId?: string; sessionId?: string } = {}) => ({
    terminalId: overrides.terminalId ?? null,
    agentId: null,
    sessionId: overrides.sessionId ?? null,
    conversationTouched: false,
    figures: [],
    activeFigureNumber: null,
  });

  it("finds room in a free slot, or an open tab with nothing in it", async () => {
    const { useHelpPanelStore: store, selectHasRoomForSession } = await import("../helpPanelStore");
    store.setState({ sessions: { 0: lane({ terminalId: "t0" }) }, hibernateSessions: {} });
    expect(selectHasRoomForSession(store.getState(), "p1")).toBe(true);

    store.setState({
      sessions: {
        0: lane({ terminalId: "t0" }),
        1: lane({ sessionId: "s1" }),
        2: lane(),
      },
    });
    expect(selectHasRoomForSession(store.getState(), "p1")).toBe(true);
  });

  it("finds none once every tab holds a session or a conversation waiting to resume", async () => {
    const { useHelpPanelStore: store, selectHasRoomForSession } = await import("../helpPanelStore");
    store.setState({
      sessions: { 0: lane({ terminalId: "t0" }), 1: lane({ sessionId: "s1" }), 2: lane() },
      hibernateSessions: {
        [slotKey("p1", 2)]: { sessionId: "kept", cwd: "/help.codex", agentId: "codex" },
      },
    });
    expect(selectHasRoomForSession(store.getState(), "p1")).toBe(false);
    // Another project's capture doesn't hold this project's tab.
    expect(selectHasRoomForSession(store.getState(), "p2")).toBe(true);
  });
});
