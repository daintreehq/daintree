import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalPersistence } from "../terminalPersistence";
import type { TerminalInstance, TerminalState } from "@/types";

const createMockTerminal = (overrides: Partial<TerminalInstance> = {}): TerminalInstance => ({
  id: "test-1",
  type: "terminal",
  title: "Test Terminal",
  cwd: "/test/path",
  cols: 80,
  rows: 24,
  location: "grid",
  ...overrides,
});

const createMockClient = () => ({
  getState: vi.fn().mockResolvedValue({}),
  setState: vi.fn().mockResolvedValue(undefined),
  getVersion: vi.fn().mockResolvedValue("1.0.0"),
  hydrate: vi.fn().mockResolvedValue({}),
});

describe("TerminalPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("creates instance with default options", () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client);
      expect(persistence).toBeInstanceOf(TerminalPersistence);
    });

    it("creates instance with custom options", () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, {
        debounceMs: 1000,
        filter: () => true,
        transform: (t): TerminalState => ({ id: t.id, type: t.type, title: t.title, cwd: t.cwd }),
      });
      expect(persistence).toBeInstanceOf(TerminalPersistence);
    });
  });

  describe("save", () => {
    it("debounces multiple saves into single persist call", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal();
      persistence.save([terminal]);
      persistence.save([terminal, createMockTerminal({ id: "test-2" })]);
      persistence.save([terminal]);

      expect(client.setState).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).toHaveBeenCalledTimes(1);
    });

    it("excludes trashed terminals by default", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const gridTerminal = createMockTerminal({ id: "grid-1", location: "grid" });
      const dockTerminal = createMockTerminal({ id: "dock-1", location: "dock" });
      const trashedTerminal = createMockTerminal({ id: "trash-1", location: "trash" });

      persistence.save([gridTerminal, dockTerminal, trashedTerminal]);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).toHaveBeenCalledWith({
        terminals: expect.arrayContaining([
          expect.objectContaining({ id: "grid-1" }),
          expect.objectContaining({ id: "dock-1" }),
        ]),
      });

      const savedTerminals = (client.setState.mock.calls[0][0] as { terminals: unknown[] })
        .terminals;
      expect(savedTerminals).toHaveLength(2);
      expect(savedTerminals).not.toContainEqual(expect.objectContaining({ id: "trash-1" }));
    });

    it("transforms terminals with default transform", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal({
        id: "test-1",
        type: "claude",
        title: "Claude",
        cwd: "/test",
        worktreeId: "wt-1",
        location: "grid",
        command: "  claude --model sonnet-4  ",
        agentState: "working",
        activityHeadline: "Processing",
      });

      persistence.save([terminal]);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).toHaveBeenCalledWith({
        terminals: [
          {
            id: "test-1",
            type: "claude",
            title: "Claude",
            cwd: "/test",
            worktreeId: "wt-1",
            location: "grid",
            command: "claude --model sonnet-4",
          },
        ],
      });
    });

    it("applies custom filter function", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, {
        debounceMs: 100,
        filter: (t) => t.type === "claude",
      });

      const shellTerminal = createMockTerminal({ id: "shell-1", type: "terminal" });
      const claudeTerminal = createMockTerminal({ id: "claude-1", type: "claude" });

      persistence.save([shellTerminal, claudeTerminal]);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = (client.setState.mock.calls[0][0] as { terminals: unknown[] })
        .terminals;
      expect(savedTerminals).toHaveLength(1);
      expect(savedTerminals[0]).toEqual(expect.objectContaining({ id: "claude-1" }));
    });

    it("applies custom transform function", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, {
        debounceMs: 100,
        transform: (t): TerminalState => ({ id: t.id, type: t.type, title: "Custom", cwd: t.cwd }),
      });

      const terminal = createMockTerminal({
        id: "test-1",
        cwd: "/custom/path",
        title: "Should not appear",
      });

      persistence.save([terminal]);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).toHaveBeenCalledWith({
        terminals: [{ id: "test-1", type: "terminal", title: "Custom", cwd: "/custom/path" }],
      });
    });

    it("handles empty command as undefined", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const terminal = createMockTerminal({ command: "   " });

      persistence.save([terminal]);
      await vi.advanceTimersByTimeAsync(100);

      const savedTerminals = (client.setState.mock.calls[0][0] as { terminals: unknown[] })
        .terminals;
      expect((savedTerminals[0] as { command?: string }).command).toBeUndefined();
    });

    it("logs error on persist failure", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createMockClient();
      client.setState.mockRejectedValue(new Error("Persist failed"));

      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal()]);
      await vi.advanceTimersByTimeAsync(100);

      // Handle the rejection to avoid unhandled rejection error
      await expect(persistence.whenIdle()).rejects.toThrow("Persist failed");

      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "Failed to persist terminals:",
          expect.any(Error)
        );
      });

      consoleError.mockRestore();
    });
  });

  describe("flush", () => {
    it("immediately persists pending saves", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 1000 });

      const terminal = createMockTerminal();
      persistence.save([terminal]);

      expect(client.setState).not.toHaveBeenCalled();

      persistence.flush();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.setState).toHaveBeenCalledTimes(1);
    });

    it("does nothing when no pending saves", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      persistence.flush();
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).not.toHaveBeenCalled();
    });

    it("persists most recent state on flush", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 1000 });

      persistence.save([createMockTerminal({ id: "first" })]);
      persistence.save([createMockTerminal({ id: "second" })]);
      persistence.save([createMockTerminal({ id: "third" })]);

      persistence.flush();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.setState).toHaveBeenCalledTimes(1);
      expect(client.setState).toHaveBeenCalledWith({
        terminals: [expect.objectContaining({ id: "third" })],
      });
    });
  });

  describe("cancel", () => {
    it("cancels pending saves", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal()]);
      persistence.cancel();
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).not.toHaveBeenCalled();
    });

    it("allows new saves after cancel", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal({ id: "before-cancel" })]);
      persistence.cancel();

      persistence.save([createMockTerminal({ id: "after-cancel" })]);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).toHaveBeenCalledTimes(1);
      expect(client.setState).toHaveBeenCalledWith({
        terminals: [expect.objectContaining({ id: "after-cancel" })],
      });
    });
  });

  describe("debounce behavior", () => {
    it("respects custom debounce timing", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 200 });

      persistence.save([createMockTerminal()]);

      await vi.advanceTimersByTimeAsync(150);
      expect(client.setState).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(50);
      expect(client.setState).toHaveBeenCalledTimes(1);
    });

    it("resets debounce timer on subsequent saves", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal({ id: "first" })]);
      await vi.advanceTimersByTimeAsync(50);

      persistence.save([createMockTerminal({ id: "second" })]);
      await vi.advanceTimersByTimeAsync(50);

      expect(client.setState).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(50);
      expect(client.setState).toHaveBeenCalledTimes(1);
      expect(client.setState).toHaveBeenCalledWith({
        terminals: [expect.objectContaining({ id: "second" })],
      });
    });
  });

  describe("rapid update scenarios", () => {
    it("handles rapid adds without data loss", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const terminals: TerminalInstance[] = [];
      for (let i = 0; i < 10; i++) {
        terminals.push(createMockTerminal({ id: `terminal-${i}` }));
        persistence.save([...terminals]);
      }

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).toHaveBeenCalledTimes(1);
      const savedTerminals = (client.setState.mock.calls[0][0] as { terminals: unknown[] })
        .terminals;
      expect(savedTerminals).toHaveLength(10);
    });

    it("captures final state after rapid updates", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal({ id: "1", title: "First" })]);
      persistence.save([createMockTerminal({ id: "1", title: "Second" })]);
      persistence.save([createMockTerminal({ id: "1", title: "Third" })]);

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).toHaveBeenCalledWith({
        terminals: [expect.objectContaining({ title: "Third" })],
      });
    });

    it("protects against mutation after save call", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      const terminals = [createMockTerminal({ id: "test-1", title: "Original" })];
      persistence.save(terminals);

      terminals[0].title = "Mutated";

      await vi.advanceTimersByTimeAsync(100);

      expect(client.setState).toHaveBeenCalledWith({
        terminals: [expect.objectContaining({ title: "Original" })],
      });
    });
  });

  describe("whenIdle", () => {
    it("resolves when no pending persist", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client);

      await expect(persistence.whenIdle()).resolves.toBeUndefined();
    });

    it("waits for pending persist to complete", async () => {
      const client = createMockClient();
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal()]);
      persistence.flush();

      const idlePromise = persistence.whenIdle();
      await vi.advanceTimersByTimeAsync(0);

      await expect(idlePromise).resolves.toBeUndefined();
      expect(client.setState).toHaveBeenCalledTimes(1);
    });

    it("rejects when persist fails", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createMockClient();
      client.setState.mockRejectedValue(new Error("Persist failed"));
      const persistence = new TerminalPersistence(client, { debounceMs: 100 });

      persistence.save([createMockTerminal()]);
      persistence.flush();
      await vi.advanceTimersByTimeAsync(0);

      const idlePromise = persistence.whenIdle();

      await expect(idlePromise).rejects.toThrow("Persist failed");

      consoleError.mockRestore();
    });
  });
});
