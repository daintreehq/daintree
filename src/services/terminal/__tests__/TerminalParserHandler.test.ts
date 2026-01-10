import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalParserHandler } from "../TerminalParserHandler";
import { ManagedTerminal } from "../types";

// Mock global process.env
const originalEnv = process.env;

describe("TerminalParserHandler", () => {
  let mockTerminal: any;
  let mockManaged: ManagedTerminal;
  let escHandlers: any[];
  let csiHandlers: any[];

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "test" };
    escHandlers = [];
    csiHandlers = [];

    mockTerminal = {
      parser: {
        registerEscHandler: vi.fn((opts, handler) => {
          const disposable = { dispose: vi.fn() };
          escHandlers.push({ opts, handler, disposable });
          return disposable;
        }),
        registerCsiHandler: vi.fn((opts, handler) => {
          const disposable = { dispose: vi.fn() };
          csiHandlers.push({ opts, handler, disposable });
          return disposable;
        }),
      },
    };

    mockManaged = {
      terminal: mockTerminal,
      kind: "agent", // Default to agent for blocking tests
      agentId: "codex",
      type: "codex",
    } as any;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should register alternate screen buffer exit handler", () => {
    new TerminalParserHandler(mockManaged);
    // Only DECRST (exit) handler is registered to trigger deferred resize
    // Buffer state itself is tracked via xterm.js onBufferChange in TerminalInstanceService
    const decrst = csiHandlers.find((h) => h.opts.prefix === "?" && h.opts.final === "l");
    expect(decrst).toBeDefined();
  });

  it("should NOT block TUI sequences for Claude agent terminals", () => {
    mockManaged.agentId = "claude";
    mockManaged.type = "claude";

    new TerminalParserHandler(mockManaged);

    const decstbm = csiHandlers.find((h) => h.opts.final === "r");
    const ed = csiHandlers.find((h) => h.opts.final === "J");
    const cup = csiHandlers.find((h) => h.opts.final === "H");
    const hvp = csiHandlers.find((h) => h.opts.final === "f");
    const vpa = csiHandlers.find((h) => h.opts.final === "d");

    expect(decstbm).toBeUndefined();
    expect(ed).toBeUndefined();
    expect(cup).toBeUndefined();
    expect(hvp).toBeUndefined();
    expect(vpa).toBeUndefined();
  });

  it("should NOT block TUI sequences for Codex agent terminals", () => {
    new TerminalParserHandler(mockManaged);

    const decstbm = csiHandlers.find((h) => h.opts.final === "r");
    const ed = csiHandlers.find((h) => h.opts.final === "J");
    const cup = csiHandlers.find((h) => h.opts.final === "H");
    const hvp = csiHandlers.find((h) => h.opts.final === "f");
    const vpa = csiHandlers.find((h) => h.opts.final === "d");

    expect(decstbm).toBeUndefined();
    expect(ed).toBeUndefined();
    expect(cup).toBeUndefined();
    expect(hvp).toBeUndefined();
    expect(vpa).toBeUndefined();
  });

  it("should NOT block for regular terminals", () => {
    mockManaged.kind = "terminal";
    mockManaged.agentId = undefined;

    new TerminalParserHandler(mockManaged);
    expect(escHandlers).toHaveLength(0);
    // Should have 1 handler for alternate screen buffer exit (?l)
    expect(csiHandlers).toHaveLength(1);
  });

  it("should dispose handlers correctly", () => {
    const handler = new TerminalParserHandler(mockManaged);
    // With default config (no blocking), no handlers are registered
    // But dispose should still work without errors
    expect(() => handler.dispose()).not.toThrow();
  });

  it("should handle missing parser API gracefully", () => {
    (mockManaged.terminal as any).parser = undefined; // Simulate missing API
    expect(() => new TerminalParserHandler(mockManaged)).not.toThrow();
  });
});
