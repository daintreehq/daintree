import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityWatcher, type IdentityWatcherDelegate } from "../IdentityWatcher.js";
import type { ProcessDetector } from "../../ProcessDetector.js";
import { INITIAL_FOREGROUND_SENTINEL } from "../ForegroundProcessGroupProbe.js";

interface FakeDelegateState {
  isExited: boolean;
  wasKilled: boolean;
  detectedAgentId: string | undefined;
  lastOutputTime: number;
  spawnedAt: number;
  lastDetectedProcessIconId: string | undefined;
  processDetector: ProcessDetector | null;
  visibleLines: string[];
  cursorLine: string | null;
  recentOutput: string;
  lastCommand: string | undefined;
  ptyDescendantCount: number | undefined;
  foreground: { shellPgid: number; foregroundPgid: number } | null;
  detectionCalls: Array<{ agentType?: string; processIconId?: string; isBusy: boolean }>;
}

function createFakeDelegate(overrides: Partial<FakeDelegateState> = {}): {
  delegate: IdentityWatcherDelegate;
  state: FakeDelegateState;
} {
  const state: FakeDelegateState = {
    isExited: false,
    wasKilled: false,
    detectedAgentId: undefined,
    lastOutputTime: 0,
    spawnedAt: 1_000,
    lastDetectedProcessIconId: undefined,
    processDetector: null,
    visibleLines: [],
    cursorLine: null,
    recentOutput: "",
    lastCommand: undefined,
    ptyDescendantCount: 0,
    foreground: null,
    detectionCalls: [],
    ...overrides,
  };

  const delegate: IdentityWatcherDelegate = {
    terminalId: "fake-term-12345678",
    get isExited() {
      return state.isExited;
    },
    get wasKilled() {
      return state.wasKilled;
    },
    get detectedAgentId() {
      return state.detectedAgentId;
    },
    get lastOutputTime() {
      return state.lastOutputTime;
    },
    get spawnedAt() {
      return state.spawnedAt;
    },
    get lastDetectedProcessIconId() {
      return state.lastDetectedProcessIconId;
    },
    get processDetector() {
      return state.processDetector;
    },
    getLastNLines: () => state.visibleLines,
    getCursorLine: () => state.cursorLine,
    getRecentOutput: () => state.recentOutput,
    getLastCommand: () => state.lastCommand,
    getPtyDescendantCount: () => state.ptyDescendantCount,
    readForegroundProcessGroupSnapshot: () => state.foreground,
    handleAgentDetection: (result) => {
      state.detectionCalls.push({
        agentType: result.agentType,
        processIconId: result.processIconId,
        isBusy: result.isBusy ?? false,
      });
    },
  };

  return { delegate, state };
}

describe("IdentityWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("suppress signal", () => {
    it("returns false when no signal is armed", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);
      expect(watcher.consumeSuppressSignal()).toBe(false);
    });

    it("armSuppressSignal followed by consumeSuppressSignal returns true once", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.armSuppressSignal();
      expect(watcher.consumeSuppressSignal()).toBe(true);
      expect(watcher.consumeSuppressSignal()).toBe(false);
    });

    it("multiple arm calls before consume still consume only once", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.armSuppressSignal();
      watcher.armSuppressSignal();
      expect(watcher.consumeSuppressSignal()).toBe(true);
      expect(watcher.consumeSuppressSignal()).toBe(false);
    });
  });

  describe("captureInput", () => {
    it("accumulates ASCII input and returns the line on \\r", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.captureInput("npm")).toBeUndefined();
      expect(watcher.captureInput(" run dev")).toBeUndefined();
      expect(watcher.captureInput("\r")).toBe("npm run dev");
    });

    it("returns the line on \\n separator", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.captureInput("ls -la\n")).toBe("ls -la");
    });

    it("handles backspace by removing the last character", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("nppm");
      watcher.captureInput("\b");
      watcher.captureInput("\b");
      watcher.captureInput("m");
      expect(watcher.captureInput("\r")).toBe("npm");
    });

    it("skips simple escape-prefixed sequences (e.g. function keys)", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      // Start with an ESC + single-char terminator (e.g. an alt-key sequence)
      // followed by typed text. The escape pair is consumed; the typed body
      // remains.
      watcher.captureInput("\x1bAclaude");
      expect(watcher.captureInput("\r")).toBe("claude");
    });

    it("clears its buffer between submissions", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("first\r");
      expect(watcher.captureInput("second\r")).toBe("second");
    });

    // CSI sequences end on a final byte in the 0x40–0x7E range. The previous
    // 2-state machine treated `[` (0x5B) as a final byte, dropping arrow-key
    // payloads like the `A` in `\x1b[A` straight into the buffer.
    it("does not pollute the buffer with CSI cursor-key payloads", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("\x1b[A\x1b[B\x1b[C\x1b[Dclaude");
      expect(watcher.captureInput("\r")).toBe("claude");
    });

    it("does not pollute the buffer with CSI function-key sequences (\\x1b[5~)", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("\x1b[5~\x1b[6~claude");
      expect(watcher.captureInput("\r")).toBe("claude");
    });

    it("does not pollute the buffer with OSC title sequences (\\x1b]0;…\\x07)", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("\x1b]0;window-title\x07pnpm dev");
      expect(watcher.captureInput("\r")).toBe("pnpm dev");
    });

    it("returns undefined and ignores input after dispose", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("partial");
      watcher.dispose();
      expect(watcher.captureInput("more\r")).toBeUndefined();
    });

    // PTY data isn't guaranteed to deliver a full VT sequence in a single
    // `onData` event — node-pty splits at arbitrary byte boundaries. The ESC
    // parser state must persist across captureInput calls so a sequence
    // straddling two writes (`\x1b` then `[Aclaude\r`) still parses cleanly.
    it("does not leak bytes when a CSI sequence is split across two captureInput calls", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("\x1b");
      expect(watcher.captureInput("[Aclaude\r")).toBe("claude");
    });

    it("does not leak bytes when an OSC sequence is split across two captureInput calls", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("\x1b]0;win");
      expect(watcher.captureInput("dow\x07pnpm dev\r")).toBe("pnpm dev");
    });

    // The state-3 comment claims ST (`ESC \`) recovers via the embedded-ESC
    // restart path. This is the test that pins that contract.
    it("terminates an OSC sequence on ST (\\x1b\\\\) without polluting the buffer", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.captureInput("\x1b]0;window-title\x1b\\pnpm dev");
      expect(watcher.captureInput("\r")).toBe("pnpm dev");
    });

    it("rolls the buffer when input exceeds SHELL_INPUT_BUFFER_MAX (drops oldest, keeps tail)", async () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);
      const { SHELL_INPUT_BUFFER_MAX } = await import("../IdentityWatcher.js");

      // Fill exactly to capacity, then append one more printable char. The
      // buggy implementation would drop the new char; the fixed one drops the
      // oldest so the live tail (`!`) is preserved.
      watcher.captureInput("a".repeat(SHELL_INPUT_BUFFER_MAX));
      const submitted = watcher.captureInput("!\r");
      expect(submitted).toBeDefined();
      expect(submitted).toHaveLength(SHELL_INPUT_BUFFER_MAX);
      expect(submitted!.endsWith("a!")).toBe(true);
    });
  });

  describe("onShellSubmit gating", () => {
    it("no-ops when terminal is exited", () => {
      const { delegate, state } = createFakeDelegate({ isExited: true });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("npm run dev");
      expect(watcher.pendingFallbackIdentity).toBeNull();
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("no-ops when terminal was killed", () => {
      const { delegate } = createFakeDelegate({ wasKilled: true });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("npm run dev");
      expect(watcher.pendingFallbackIdentity).toBeNull();
    });

    it("no-ops when an agent is detected and allowWhenAgentDetected is false", () => {
      const { delegate } = createFakeDelegate({ detectedAgentId: "claude" });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("npm run dev");
      expect(watcher.pendingFallbackIdentity).toBeNull();
    });

    it("arms when allowWhenAgentDetected overrides a live agent", () => {
      const { delegate } = createFakeDelegate({ detectedAgentId: "claude" });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude --version", { allowWhenAgentDetected: true });
      expect(watcher.pendingFallbackIdentity).not.toBeNull();
    });
  });

  describe("dispose", () => {
    it("prevents the poll callback from running after dispose", () => {
      // No detector path means the poll routes through delegate.handleAgentDetection.
      const { delegate, state } = createFakeDelegate({
        cursorLine: "user@host:~$ ",
        visibleLines: ["user@host:~$ "],
        ptyDescendantCount: 0,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      watcher.dispose();

      vi.advanceTimersByTime(5_000);
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("stop() is idempotent", () => {
      const { delegate } = createFakeDelegate();
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("npm run dev");
      watcher.stop();
      watcher.stop();
      expect(watcher.pendingFallbackIdentity).toBeNull();
    });

    it("onShellSubmit after dispose is inert", () => {
      // After dispose, a late onShellSubmit must not arm a new poll interval
      // or mutate any state — the watcher is dead.
      const { delegate, state } = createFakeDelegate({
        cursorLine: "user@host:~$ ",
        visibleLines: ["user@host:~$ "],
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.dispose();
      watcher.onShellSubmit("claude");

      expect(watcher.pendingFallbackIdentity).toBeNull();
      // Belt-and-suspenders: confirm no timer was armed by the late submit.
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(state.detectionCalls).toHaveLength(0);
    });

    // Past lesson #4851: containers that hold timer disposables must call
    // `.dispose()` on teardown, not just `.clear()` — otherwise leaked timer
    // handles surface as `vi.getTimerCount() > 0` after the test ends.
    it("leaves no live timers after dispose on an armed watcher", () => {
      const { delegate } = createFakeDelegate({
        cursorLine: "user@host:~$ ",
        visibleLines: ["user@host:~$ "],
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      watcher.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears injected shell evidence on dispose", () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate } = createFakeDelegate({ processDetector: fakeDetector });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      clear.mockClear();
      watcher.dispose();

      // Default ("manual") reason — respects the sole-support gate so
      // process-tree-corroborated agents aren't force-demoted on teardown.
      expect(clear).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith();
    });
  });

  describe("seed", () => {
    it("falls back to direct detection when no processDetector is attached", async () => {
      const { delegate, state } = createFakeDelegate({ processDetector: null });
      const watcher = new IdentityWatcher(delegate);

      watcher.seed("claude --version");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(state.detectionCalls).toEqual([
        {
          agentType: "claude",
          processIconId: "claude",
          isBusy: true,
        },
      ]);
      expect(watcher.seededCommandText).toBeUndefined();
      watcher.dispose();
    });

    it("injects shell-command evidence when a processDetector is attached", () => {
      const inject = vi.fn();
      const fakeDetector = { injectShellCommandEvidence: inject } as unknown as ProcessDetector;
      const { delegate } = createFakeDelegate({ processDetector: fakeDetector });
      const watcher = new IdentityWatcher(delegate);

      watcher.seed("claude --model sonnet");
      expect(inject).toHaveBeenCalledTimes(1);
      const [identity, normalizedText] = inject.mock.calls[0];
      expect(identity).toMatchObject({ agentType: "claude" });
      expect(normalizedText).toBe("claude --model sonnet");
    });

    it("clears seededCommandText after the synchronous seed flow", () => {
      const fakeDetector = {
        injectShellCommandEvidence: vi.fn(),
      } as unknown as ProcessDetector;
      const { delegate } = createFakeDelegate({ processDetector: fakeDetector });
      const watcher = new IdentityWatcher(delegate);

      watcher.seed("claude");
      expect(watcher.seededCommandText).toBeUndefined();
    });

    it("does not inject evidence when seeded after dispose", () => {
      const inject = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: vi.fn(),
      } as unknown as ProcessDetector;
      const { delegate } = createFakeDelegate({ processDetector: fakeDetector });
      const watcher = new IdentityWatcher(delegate);

      watcher.dispose();
      inject.mockClear();
      watcher.seed("claude --version");

      expect(inject).not.toHaveBeenCalled();
      expect(watcher.seededCommandText).toBeUndefined();
    });
  });

  describe("commit & demote (detector path — primary production flow)", () => {
    it("calls processDetector.injectShellCommandEvidence on commit", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["pnpm dev\r\n", "> dev output"],
        cursorLine: "> dev output",
        ptyDescendantCount: 2,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("pnpm dev");
      await vi.advanceTimersByTimeAsync(2_000);

      // Detector path is taken — handleAgentDetection is NOT called directly.
      expect(state.detectionCalls).toHaveLength(0);
      expect(inject).toHaveBeenCalledTimes(1);
      const [identity, commandText] = inject.mock.calls[0];
      expect(identity).toMatchObject({ processIconId: "pnpm" });
      expect(commandText).toBe("pnpm dev");
      expect(watcher.isFallbackCommitted).toBe(true);
    });

    it("does not stop icon fallback when a prompt-looking line is visible but a child is still running", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ['PS C:\\repo> node -e "setTimeout(()=>{}, 8000)"', "PS C:\\repo> "],
        cursorLine: "PS C:\\repo> ",
        ptyDescendantCount: 1,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit('node -e "setTimeout(()=>{}, 8000)"');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(inject).toHaveBeenCalledTimes(1);
      const [identity, commandText] = inject.mock.calls[0];
      expect(identity).toMatchObject({ processIconId: "node" });
      expect(commandText).toBe('node -e "setTimeout(()=>{}, 8000)"');
    });

    it("does not stop icon fallback when descendant count is unavailable", async () => {
      const { delegate, state } = createFakeDelegate({
        processDetector: null,
        visibleLines: ['PS C:\\repo> node -e "setTimeout(()=>{}, 8000)"', "PS C:\\repo> "],
        cursorLine: "PS C:\\repo> ",
        ptyDescendantCount: undefined,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit('node -e "setTimeout(()=>{}, 8000)"');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(state.detectionCalls).toEqual([
        {
          agentType: undefined,
          processIconId: "node",
          isBusy: true,
        },
      ]);
      watcher.dispose();
    });

    it("calls processDetector.clearShellCommandEvidence('prompt-return') on demotion", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["claude\r\n", "Starting Claude Code..."],
        cursorLine: "Starting Claude Code...",
        ptyDescendantCount: 1,
        foreground: { shellPgid: 123, foregroundPgid: 123 },
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = ["user@host daintree % "];
      state.cursorLine = "user@host daintree % ";
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      // handleAgentDetection is the legacy fallback; not used when detector is present.
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("calls processDetector.clearShellCommandEvidence('prompt-return') after a PowerShell prompt returns", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["& 'C:\\npm\\prefix\\claude.cmd'", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 2,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      const powerShellPrompt = "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>";
      state.visibleLines = ["FAKE_CLAUDE_EXIT", powerShellPrompt];
      state.cursorLine = powerShellPrompt;
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears shell evidence when a real shell prompt returns after stale agent UI text", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["claude", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 1,
        foreground: { shellPgid: 123, foregroundPgid: 456 },
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = [
        "Quick safety check: Is this a project you created or one you trust?",
        "Enter to confirm · Esc to cancel",
        "FAKE_CLAUDE_EXIT",
        "user@host daintree % ",
      ];
      state.cursorLine = "user@host daintree % ";
      state.ptyDescendantCount = 0;
      state.foreground = { shellPgid: 123, foregroundPgid: 123 };
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears shell evidence when POSIX foreground ownership returns to the shell", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["claude", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 1,
        foreground: { shellPgid: 123, foregroundPgid: 456 },
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = [
        "Quick safety check: Is this a project you created or one you trust?",
        " ❯ 1. Yes, I trust this folder",
        "Enter to confirm · Esc to cancel",
        "FAKE_CLAUDE_EXIT",
      ];
      state.cursorLine = "";
      state.ptyDescendantCount = 0;
      state.foreground = { shellPgid: 123, foregroundPgid: 123 };
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears shell evidence on POSIX foreground return even when no prompt text is visible", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["claude", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 1,
        foreground: { shellPgid: 123, foregroundPgid: 456 },
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = ["FAKE_CLAUDE_EXIT", ""];
      state.cursorLine = "";
      state.ptyDescendantCount = 0;
      state.foreground = { shellPgid: 123, foregroundPgid: 123 };
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears shell evidence when the POSIX shell regains foreground with a lingering descendant", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["claude", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 2,
        foreground: { shellPgid: 123, foregroundPgid: 456 },
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      // The interactive agent exited and the shell owns the PTY again, but a
      // background helper still appears below the shell in the process tree.
      // The prompt output races ahead of the foreground-PGID refresh, while
      // stale alternate-screen text remains in the semantic buffer.
      watcher.observeOutput("runner@host:/repo$ ");
      state.visibleLines = [
        "Quick safety check: Is this a project you created or one you trust?",
        " ❯ 1. Yes, I trust this folder",
        "Enter to confirm · Esc to cancel",
        "FAKE_CLAUDE_EXIT",
      ];
      state.cursorLine = "";
      state.ptyDescendantCount = 1;
      state.foreground = { shellPgid: 123, foregroundPgid: 123 };
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears shell evidence on non-POSIX child exit even when no prompt text is visible", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["& 'C:\\npm\\prefix\\claude.cmd'", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 2,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = ["FAKE_CLAUDE_READY", "FAKE_CLAUDE_EXIT"];
      state.cursorLine = "";
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("ignores stale agent trust text when the current Windows prompt has returned", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: [
          "Quick safety check: Is this a project you created or one you trust?",
          "FAKE_CLAUDE_READY",
        ],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 1,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = [
        "Quick safety check: Is this a project you created or one you trust?",
        "FAKE_CLAUDE_READY",
        "__DAINTREE_FAKE_CLAUDE_STOP__",
        "FAKE_CLAUDE_EXIT",
      ];
      state.cursorLine = "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>";
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears agent evidence when the bottom visible Windows prompt returns below a stale cursor line", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const powerShellPrompt = "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>";
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["& 'C:\\npm\\prefix\\claude.cmd'", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 1,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = [
        "Quick safety check: Is this a project you created or one you trust?",
        "FAKE_CLAUDE_READY",
        "__DAINTREE_FAKE_CLAUDE_STOP__",
        "FAKE_CLAUDE_EXIT",
        powerShellPrompt,
      ];
      state.cursorLine = "FAKE_CLAUDE_EXIT";
      state.ptyDescendantCount = undefined;
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("holds agent demotion when a Windows-style prompt is visible but a child process remains active", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["& 'C:\\npm\\prefix\\claude.cmd'", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 1,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = ["FAKE_CLAUDE_READY", "> "];
      state.cursorLine = "> ";
      state.ptyDescendantCount = 1;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(clear).not.toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("holds agent demotion for a bare agent prompt when Windows descendants are missed", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["& 'C:\\npm\\prefix\\claude.cmd' --manual", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 0,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd' --manual");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = ["FAKE_CLAUDE_READY pid=8024", "FAKE_CLAUDE_MANUAL=1", "> "];
      state.cursorLine = "> ";
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(clear).not.toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears agent evidence when a current PowerShell prompt follows stale Claude welcome text", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const powerShellPrompt = "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>";
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["& 'C:\\npm\\prefix\\claude.cmd'", "Welcome to Claude Code"],
        cursorLine: "Welcome to Claude Code",
        ptyDescendantCount: undefined,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = ["Welcome to Claude Code", "? for shortcuts", powerShellPrompt];
      state.cursorLine = powerShellPrompt;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears agent evidence when a current PowerShell prompt returns despite stale Windows descendants", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const powerShellPrompt = "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>";
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["& 'C:\\npm\\prefix\\claude.cmd'", "Welcome back!"],
        cursorLine: "Welcome back!",
        ptyDescendantCount: 2,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = ["Welcome back!", "? for shortcuts", powerShellPrompt];
      state.cursorLine = powerShellPrompt;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("keeps watching after live agent detection already matches the fallback identity", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const powerShellPrompt = "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>";
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        detectedAgentId: "claude",
        lastDetectedProcessIconId: "claude",
        visibleLines: [
          "Quick safety check: Is this a project you created or one you trust?",
          "FAKE_CLAUDE_READY",
        ],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 2,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'", { allowWhenAgentDetected: true });
      await vi.advanceTimersByTimeAsync(400);

      expect(watcher.isFallbackCommitted).toBe(true);
      expect(inject).not.toHaveBeenCalled();

      state.visibleLines = [
        "Quick safety check: Is this a project you created or one you trust?",
        "FAKE_CLAUDE_READY",
        "__DAINTREE_FAKE_CLAUDE_STOP__",
        "FAKE_CLAUDE_EXIT",
        powerShellPrompt,
      ];
      state.cursorLine = powerShellPrompt;
      state.recentOutput = [
        "__DAINTREE_FAKE_CLAUDE_STOP__",
        "FAKE_CLAUDE_EXIT",
        powerShellPrompt,
      ].join("\r\n");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toEqual([
        {
          agentType: undefined,
          processIconId: undefined,
          isBusy: false,
        },
      ]);
    });

    it("clears live-matched agent evidence when raw output contains a returned PowerShell prompt", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const powerShellPrompt = "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>";
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        detectedAgentId: "claude",
        lastDetectedProcessIconId: "claude",
        visibleLines: ["FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 2,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'", { allowWhenAgentDetected: true });
      await vi.advanceTimersByTimeAsync(400);

      watcher.observeOutput(
        `__DAINTREE_FAKE_CLAUDE_STOP__\r\nFAKE_CLAUDE_EXIT\r\n${powerShellPrompt}`
      );

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(inject).not.toHaveBeenCalled();
      expect(state.detectionCalls).toHaveLength(1);
      expect(state.detectionCalls[0].isBusy).toBe(false);
    });

    it("keeps live agent evidence when raw output has a stale shell prompt but visible Claude UI is active", async () => {
      const clear = vi.fn();
      const fakeDetector = {
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        detectedAgentId: "claude",
        lastDetectedProcessIconId: "claude",
        visibleLines: ["Welcome to Claude Code", "? for shortcuts", ">"],
        cursorLine: ">",
        ptyDescendantCount: 1,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.stop();
      watcher.observeOutput("PS C:\\Users\\runneradmin\\project>");

      expect(clear).not.toHaveBeenCalled();
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("keeps live Windows Claude welcome UI when descendants are temporarily missed", async () => {
      const clear = vi.fn();
      const fakeDetector = {
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        detectedAgentId: "claude",
        lastDetectedProcessIconId: "claude",
        visibleLines: [
          "Claude Code v2.1.195",
          "Welcome back!",
          "Tips for getting started",
          '> Try "fix typecheck errors"',
          "? for shortcuts · ↵ for agents",
        ],
        cursorLine: '> Try "fix typecheck errors"',
        ptyDescendantCount: 0,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.stop();
      watcher.observeOutput("PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>");

      expect(clear).not.toHaveBeenCalled();
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears detected agent evidence from raw output even after fallback state stopped", () => {
      const clear = vi.fn();
      const fakeDetector = {
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        detectedAgentId: "claude",
        lastDetectedProcessIconId: "claude",
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.stop();
      watcher.observeOutput("FAKE_CLAUDE_EXIT\r\nPS C:\\Users\\runneradmin\\project>");

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(1);
      expect(state.detectionCalls[0].isBusy).toBe(false);
    });

    it("clears agent evidence when only the Windows shell descendant remains at a returned PowerShell prompt", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const powerShellPrompt = "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>";
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["& 'C:\\npm\\prefix\\claude.cmd'", "FAKE_CLAUDE_READY"],
        cursorLine: "FAKE_CLAUDE_READY",
        ptyDescendantCount: 2,
        foreground: null,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("& 'C:\\npm\\prefix\\claude.cmd'");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.visibleLines = ["FAKE_CLAUDE_READY", "FAKE_CLAUDE_EXIT", powerShellPrompt];
      state.cursorLine = powerShellPrompt;
      state.ptyDescendantCount = 1;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      expect(state.detectionCalls).toHaveLength(0);
    });

    // Inverse of the OR→AND test below: fallback is icon-only (no agentType),
    // live icon disagrees. A correct AND check must let the commit proceed
    // rather than pre-empting on the (absent) agentType match.
    it("does not pre-empt commit when an icon-only fallback identity disagrees with live icon", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate } = createFakeDelegate({
        processDetector: fakeDetector,
        // Fallback identity will be `{ processIconId: "pnpm" }` (no agentType
        // because pnpm isn't in AGENT_CLI_NAMES). Live icon disagrees.
        lastDetectedProcessIconId: "npm",
        visibleLines: ["pnpm dev\r\n", "> dev output"],
        cursorLine: "> dev output",
        ptyDescendantCount: 1,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("pnpm dev");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(inject).toHaveBeenCalledTimes(1);
      const [identity] = inject.mock.calls[0];
      expect(identity).toMatchObject({ processIconId: "pnpm" });
    });

    // Bug 2: liveIdentityMatchesFallback used OR. A stale process icon (from a
    // prior `claude` run whose icon hadn't been demoted yet) could short-
    // circuit the commit even when the live agent type disagreed — and vice
    // versa. The AND form requires every populated identity field to agree.
    it("does not pre-empt commit when only one identity field agrees with live state", async () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        // detectedAgentId matches identity.agentType ("claude") — but the
        // process icon disagrees (live is `pnpm`, fallback identity is
        // `claude`). A correct AND check rejects the live state and lets the
        // fallback commit fresh evidence.
        detectedAgentId: "claude",
        lastDetectedProcessIconId: "pnpm",
        // allowWhenAgentDetected is required because detectedAgentId is set.
        visibleLines: ["claude\r\n", "Starting Claude Code..."],
        cursorLine: "Starting Claude Code...",
        ptyDescendantCount: 1,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude", { allowWhenAgentDetected: true });
      await vi.advanceTimersByTimeAsync(2_000);

      // With OR: commit short-circuited (no inject call). With AND: commit
      // proceeds because processIconId disagrees, so injectShellCommandEvidence
      // fires with the watcher's identity.
      expect(inject).toHaveBeenCalledTimes(1);
      expect(state.detectionCalls).toHaveLength(0);
    });

    it("clears stale shell evidence when a new no-identity command is submitted", () => {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate } = createFakeDelegate({ processDetector: fakeDetector });
      const watcher = new IdentityWatcher(delegate);

      // `echo hi` has no recognizable identity — must clear stale evidence
      // immediately so the prior badge doesn't stay sticky for the full TTL.
      watcher.onShellSubmit("echo hi");
      expect(clear).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith();
      expect(inject).not.toHaveBeenCalled();
    });
  });

  describe("commit & demote (no detector path)", () => {
    it("commits agent identity after the commit window when prompt is hidden", async () => {
      const { delegate, state } = createFakeDelegate({
        visibleLines: ["claude\r\n", "Starting Claude Code..."],
        cursorLine: "Starting Claude Code...",
        ptyDescendantCount: 1,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      // Commit window is 1200 ms; advance enough polls to clear it.
      await vi.advanceTimersByTimeAsync(2_000);

      expect(state.detectionCalls).toHaveLength(1);
      expect(state.detectionCalls[0].agentType).toBe("claude");
      expect(state.detectionCalls[0].isBusy).toBe(true);
      expect(watcher.isFallbackCommitted).toBe(true);
    });

    it("demotes after prompt return (two consecutive prompt polls)", async () => {
      const { delegate, state } = createFakeDelegate({
        visibleLines: ["claude\r\n", "Starting Claude Code..."],
        cursorLine: "Starting Claude Code...",
        ptyDescendantCount: 1,
        foreground: { shellPgid: 123, foregroundPgid: 123 },
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      // Now show a shell prompt — two consecutive polls should trigger demotion.
      state.visibleLines = ["user@host daintree % "];
      state.cursorLine = "user@host daintree % ";
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(600);

      const lastCall = state.detectionCalls[state.detectionCalls.length - 1];
      expect(lastCall).toMatchObject({
        agentType: undefined,
        processIconId: undefined,
        isBusy: false,
      });
    });

    // macOS CI runners ship `\h:\W \u\$ ` (no `@`, `:` separator); regression
    // for the "claude exits, prompt back, badge stuck" failure on those hosts.
    it("demotes after macOS bash default prompt returns (host:cwd user$)", async () => {
      const { delegate, state } = createFakeDelegate({
        visibleLines: ["claude\r\n", "Starting Claude Code..."],
        cursorLine: "Starting Claude Code...",
        ptyDescendantCount: 1,
        foreground: { shellPgid: 123, foregroundPgid: 123 },
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      const macOsBashPrompt =
        "iad20-fj920-8588b331-e81f-4e5d-b027-88cf9594933d-165A4DA9C335:daintree-e2e-terminal-agent-promotion-1EOmA5 runner$ ";
      state.visibleLines = [macOsBashPrompt];
      state.cursorLine = macOsBashPrompt;
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(600);

      const lastCall = state.detectionCalls[state.detectionCalls.length - 1];
      expect(lastCall).toMatchObject({
        agentType: undefined,
        processIconId: undefined,
        isBusy: false,
      });
    });
  });

  describe("hasRecentCommandFailureOutput — locale-independent detection", () => {
    // The detector is private; behavior is verified through the demotion gate.
    // Branch at IdentityWatcher.poll() line ~368: when foreground is busy AND
    // no failure phrase is in recent output, demotion is held. A failure
    // phrase bypasses the hold and allows demotion. Issue #6062.
    const localizedFailures = [
      { locale: "English (command not found)", phrase: "bash: claude: command not found" },
      { locale: "English (no such file)", phrase: "bash: ./claude: No such file or directory" },
      { locale: "French", phrase: "bash: claude : commande introuvable" },
      { locale: "German", phrase: "bash: claude: Befehl nicht gefunden" },
      { locale: "Spanish (es_MX)", phrase: "bash: claude: no se encontró la orden" },
      { locale: "Spanish (es_ES)", phrase: "bash: claude: orden no encontrada" },
      { locale: "Japanese", phrase: "bash: claude: コマンドが見つかりません" },
      { locale: "Chinese (Simplified)", phrase: "bash: claude: 未找到命令" },
      { locale: "Russian", phrase: "bash: claude: команда не найдена" },
      { locale: "Portuguese", phrase: "bash: claude: comando não encontrado" },
      { locale: "Italian", phrase: "bash: claude: comando non trovato" },
      { locale: "Korean", phrase: "bash: claude: 명령어를 찾을 수 없습니다" },
      { locale: "Dutch", phrase: "bash: claude: opdracht niet gevonden" },
      { locale: "Fish shell", phrase: "fish: Unknown command: claude" },
      {
        locale: "PowerShell (CommandNotFoundException)",
        phrase:
          "claude : The term 'claude' is not recognized. + FullyQualifiedErrorId : CommandNotFoundException",
      },
      {
        locale: "PowerShell (is not recognized — tail-window fallback)",
        phrase: "claude : The term 'claude' is not recognized as the name of a cmdlet",
      },
    ];

    it.each(localizedFailures)(
      "bypasses demotion hold when '$locale' failure is in recent output",
      async ({ phrase }) => {
        const { delegate, state } = createFakeDelegate({
          visibleLines: ["claude\r\n", "Starting Claude Code..."],
          cursorLine: "Starting Claude Code...",
          ptyDescendantCount: 1,
          // Foreground is busy (shell pgid != foreground pgid) — would
          // normally hold demotion until the regex match overrides it.
          foreground: { shellPgid: 123, foregroundPgid: 456 },
        });
        const watcher = new IdentityWatcher(delegate);

        watcher.onShellSubmit("claude");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(watcher.isFallbackCommitted).toBe(true);
        // First call is the commit (isBusy=true).
        expect(state.detectionCalls).toHaveLength(1);

        // Now show a shell prompt with the localized failure phrase, while
        // foreground stays busy. Without the regex bypass, branch 1 holds.
        state.visibleLines = ["user@host daintree % ", phrase, "user@host daintree % "];
        state.cursorLine = "user@host daintree % ";
        state.ptyDescendantCount = 0;
        state.foreground = { shellPgid: 123, foregroundPgid: 456 };
        await vi.advanceTimersByTimeAsync(600);

        const lastCall = state.detectionCalls[state.detectionCalls.length - 1];
        expect(lastCall).toMatchObject({
          agentType: undefined,
          processIconId: undefined,
          isBusy: false,
        });
      }
    );

    it("holds demotion when no failure phrase is present and foreground is busy", async () => {
      const { delegate, state } = createFakeDelegate({
        visibleLines: ["claude\r\n", "Starting Claude Code..."],
        cursorLine: "Starting Claude Code...",
        ptyDescendantCount: 1,
        foreground: { shellPgid: 123, foregroundPgid: 456 },
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("claude");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      // Prompt visible, no failure phrase, foreground still busy — hold.
      state.visibleLines = ["user@host daintree % ", "(no failure here)", "user@host daintree % "];
      state.cursorLine = "user@host daintree % ";
      state.ptyDescendantCount = 0;
      state.foreground = { shellPgid: 123, foregroundPgid: 456 };
      await vi.advanceTimersByTimeAsync(600);

      // Only the commit call should exist; no demotion fired.
      expect(state.detectionCalls).toHaveLength(1);
      expect(state.detectionCalls[0].isBusy).toBe(true);
    });
  });

  describe("hasAgentUiPromptFalsePositive", () => {
    it("returns true for trust-prompt UI text", () => {
      const { delegate } = createFakeDelegate({
        visibleLines: ["", "Accessing workspace:", " ❯ 1. Yes, I trust this folder"],
        cursorLine: " ❯ 1. Yes, I trust this folder",
      });
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.hasAgentUiPromptFalsePositive()).toBe(true);
    });

    it("returns true for Windows Claude trust-prompt text with ASCII selector", () => {
      const { delegate } = createFakeDelegate({
        visibleLines: [
          "Accessing workspace:",
          "Quick safety check: Is this a project you created or one you trust?",
          "> 1. Yes, I trust this folder",
          "Enter to confirm · Esc to cancel",
        ],
        cursorLine: "",
      });
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.hasAgentUiPromptFalsePositive()).toBe(true);
    });

    it("returns false for a normal shell prompt line", () => {
      const { delegate } = createFakeDelegate({
        visibleLines: ["", "user@host daintree % "],
        cursorLine: "user@host daintree % ",
      });
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.hasAgentUiPromptFalsePositive()).toBe(false);
    });

    it("returns false when stale agent prompt text precedes a real shell prompt", () => {
      const { delegate } = createFakeDelegate({
        visibleLines: [
          "Quick safety check: Is this a project you created or one you trust?",
          "Enter to confirm · Esc to cancel",
          "FAKE_CLAUDE_EXIT",
          "user@host daintree % ",
        ],
        cursorLine: "user@host daintree % ",
      });
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.hasAgentUiPromptFalsePositive()).toBe(false);
    });

    it("returns false when stale agent prompt text precedes a single-char shell prompt", () => {
      const { delegate } = createFakeDelegate({
        visibleLines: [
          "Quick safety check: Is this a project you created or one you trust?",
          "Enter to confirm · Esc to cancel",
          "FAKE_CLAUDE_EXIT",
          "$ ",
        ],
        cursorLine: "$ ",
      });
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.hasAgentUiPromptFalsePositive()).toBe(false);
    });

    it("returns true for Claude Code's idle input prompt", () => {
      const { delegate } = createFakeDelegate({
        visibleLines: [
          "────────────────────────────────────────────────────────────────────────",
          "> ",
          "────────────────────────────────────────────────────────────────────────",
          "? for shortcuts",
        ],
        cursorLine: "> ",
      });
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.hasAgentUiPromptFalsePositive()).toBe(true);
    });

    it("returns true for a bare agent input prompt without descendant evidence", () => {
      const { delegate } = createFakeDelegate({
        visibleLines: ["FAKE_CLAUDE_MANUAL=1", "> "],
        cursorLine: "> ",
      });
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.hasAgentUiPromptFalsePositive()).toBe(true);
    });

    it("returns true for Claude Code's Windows welcome prompt when the input marker scrolled out", () => {
      const { delegate } = createFakeDelegate({
        visibleLines: [
          "Claude Code v2.1.136",
          "Welcome back!",
          "Tips for getting started",
          "? for shortcuts",
        ],
        cursorLine: "",
      });
      const watcher = new IdentityWatcher(delegate);

      expect(watcher.hasAgentUiPromptFalsePositive()).toBe(true);
    });
  });

  describe("Codex agent-detection flap hardening (#10911)", () => {
    function makeCommittedCodexWatcher(
      overrides: Partial<Parameters<typeof createFakeDelegate>[0]> = {}
    ) {
      const inject = vi.fn();
      const clear = vi.fn();
      const fakeDetector = {
        injectShellCommandEvidence: inject,
        clearShellCommandEvidence: clear,
      } as unknown as ProcessDetector;
      const { delegate, state } = createFakeDelegate({
        processDetector: fakeDetector,
        visibleLines: ["codex", "Codex ready"],
        cursorLine: "Codex ready",
        ptyDescendantCount: 1,
        // A valid foreground snapshot (child active) during commit both keeps
        // the agent from demoting and latches sawForegroundSnapshot so a later
        // null read is treated as a transient failure.
        foreground: { shellPgid: 123, foregroundPgid: 456 },
        ...overrides,
      });
      return { delegate, state, clear, inject };
    }

    it("does not demote on a Codex `›` composer line while the shell is idle", async () => {
      const { delegate, state, clear } = makeCommittedCodexWatcher();
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("codex");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      // Foreground genuinely reports idle, but the visible tail is Codex's own
      // composer echo — the `›` glyph must NOT count as a returned prompt.
      state.foreground = { shellPgid: 123, foregroundPgid: 123 };
      state.visibleLines = ["Codex ready", "› draft a commit message"];
      state.cursorLine = "› draft a commit message";
      watcher.observeOutput("› draft a commit message\n");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(clear).not.toHaveBeenCalledWith("prompt-return");
      expect(watcher.isFallbackCommitted).toBe(true);
      watcher.dispose();
    });

    it("still demotes on a real oh-my-zsh `➜` prompt while committed (exclusion is surgical)", async () => {
      const { delegate, state, clear } = makeCommittedCodexWatcher();
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("codex");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.foreground = { shellPgid: 123, foregroundPgid: 123 };
      state.visibleLines = ["Codex ready", "➜  my-repo git:(main)"];
      state.cursorLine = "➜  my-repo git:(main)";
      state.ptyDescendantCount = 0;
      watcher.observeOutput("➜  my-repo git:(main)\n");

      expect(clear).toHaveBeenCalledWith("prompt-return");
      watcher.dispose();
    });

    it("fails closed on a transient null foreground snapshot instead of demoting", async () => {
      const { delegate, state, clear } = makeCommittedCodexWatcher();
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("codex");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      // Probe goes stale/null (ps timeout) right as a real-looking shell prompt
      // scrolls by. Because the probe worked before, this is a transient window
      // and must hold the agent rather than demote on ambiguous state.
      state.foreground = null;
      state.visibleLines = ["Codex ready", "user@host daintree % "];
      state.cursorLine = "user@host daintree % ";
      watcher.observeOutput("user@host daintree % \n");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(clear).not.toHaveBeenCalledWith("prompt-return");
      expect(watcher.isFallbackCommitted).toBe(true);
      watcher.dispose();
    });

    it("falls open (legacy path) when the probe only ever returned the warm-up sentinel", async () => {
      // Regression guard for the sentinel latch: during warm-up the probe hands
      // back INITIAL_FOREGROUND_SENTINEL (synthetic, not a real reading). If the
      // real `ps` probe then never resolves and returns null, the terminal must
      // fall back to the legacy prompt path — NOT fail closed forever — because
      // the probe was never actually confirmed to work here. #10911
      const { delegate, state, clear } = makeCommittedCodexWatcher({
        foreground: INITIAL_FOREGROUND_SENTINEL,
      });
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("codex");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.foreground = null; // real probe died before ever succeeding
      state.visibleLines = ["Codex exited", "user@host daintree % "];
      state.cursorLine = "user@host daintree % ";
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      watcher.dispose();
    });

    it("does not treat bare or numbered `›`/`❯` agent lines as a prompt while committed", async () => {
      const { delegate, state, clear } = makeCommittedCodexWatcher();
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("codex");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      state.foreground = { shellPgid: 123, foregroundPgid: 123 };
      for (const line of [
        "›",
        "❯",
        "❯ write the tests",
        "› 1. first option",
        "> 1. first option",
      ]) {
        state.visibleLines = ["Codex ready", line];
        state.cursorLine = line;
        watcher.observeOutput(`${line}\n`);
      }
      await vi.advanceTimersByTimeAsync(400);

      expect(clear).not.toHaveBeenCalledWith("prompt-return");
      expect(watcher.isFallbackCommitted).toBe(true);
      watcher.dispose();
    });

    it("still demotes on a genuine idle shell after the agent exits", async () => {
      const { delegate, state, clear } = makeCommittedCodexWatcher();
      const watcher = new IdentityWatcher(delegate);

      watcher.onShellSubmit("codex");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(watcher.isFallbackCommitted).toBe(true);

      // Real exit: foreground ownership returns to the shell and the child is
      // gone. A fresh idle snapshot is authoritative — demotion must proceed.
      state.foreground = { shellPgid: 123, foregroundPgid: 123 };
      state.visibleLines = ["Codex exited", "user@host daintree % "];
      state.cursorLine = "user@host daintree % ";
      state.ptyDescendantCount = 0;
      await vi.advanceTimersByTimeAsync(600);

      expect(clear).toHaveBeenCalledWith("prompt-return");
      watcher.dispose();
    });
  });
});
