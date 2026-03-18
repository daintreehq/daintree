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
  let oscHandlers: any[];

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "test" };
    escHandlers = [];
    csiHandlers = [];
    oscHandlers = [];

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
        registerOscHandler: vi.fn((ident: number, handler: (data: string) => boolean) => {
          const disposable = { dispose: vi.fn() };
          oscHandlers.push({ ident, handler, disposable });
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
    // 1 alt screen exit (?l) + 2 DECRQM blockers (? $ p and $ p)
    expect(csiHandlers).toHaveLength(3);
    // OSC 52 clipboard block applies unconditionally to all terminal kinds
    expect(oscHandlers).toHaveLength(1);
    expect(oscHandlers[0].ident).toBe(52);
  });

  it("should block DECRQM queries to prevent xterm.js parser crash", () => {
    mockManaged.kind = "terminal";
    mockManaged.agentId = undefined;

    new TerminalParserHandler(mockManaged);

    const privateDecrqm = csiHandlers.find(
      (h) => h.opts.prefix === "?" && h.opts.intermediates === "$" && h.opts.final === "p"
    );
    const nonPrivateDecrqm = csiHandlers.find(
      (h) => !h.opts.prefix && h.opts.intermediates === "$" && h.opts.final === "p"
    );
    expect(privateDecrqm).toBeDefined();
    expect(nonPrivateDecrqm).toBeDefined();
    // Handlers should consume (return true)
    expect(privateDecrqm.handler()).toBe(true);
    expect(nonPrivateDecrqm.handler()).toBe(true);
  });

  it("should NOT register alt screen blocker for OpenCode agent", () => {
    mockManaged.agentId = "opencode";
    mockManaged.type = "opencode";

    new TerminalParserHandler(mockManaged);

    const altScreenBlocker = csiHandlers.find((h) => h.opts.prefix === "?" && h.opts.final === "h");
    expect(altScreenBlocker).toBeUndefined();
  });

  it("should register alt screen blocker for Codex agent (blockAltScreen: true)", () => {
    mockManaged.agentId = "codex";
    mockManaged.type = "codex";

    new TerminalParserHandler(mockManaged);

    const altScreenBlocker = csiHandlers.find((h) => h.opts.prefix === "?" && h.opts.final === "h");
    expect(altScreenBlocker).toBeDefined();
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

  it("should block OSC 52 clipboard write on agent terminals", () => {
    new TerminalParserHandler(mockManaged);

    const osc52 = oscHandlers.find((h) => h.ident === 52);
    expect(osc52).toBeDefined();
    expect(osc52.handler("c;dGVzdA==")).toBe(true);
  });

  it("should block OSC 52 clipboard write on regular terminals", () => {
    mockManaged.kind = "terminal";
    mockManaged.agentId = undefined;

    new TerminalParserHandler(mockManaged);

    const osc52 = oscHandlers.find((h) => h.ident === 52);
    expect(osc52).toBeDefined();
    expect(osc52.handler("c;dGVzdA==")).toBe(true);
  });

  it("should dispose OSC 52 handler correctly", () => {
    const handler = new TerminalParserHandler(mockManaged);
    const osc52 = oscHandlers.find((h) => h.ident === 52);
    expect(osc52).toBeDefined();

    handler.dispose();
    expect(osc52.disposable.dispose).toHaveBeenCalled();
  });
});
