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
      kind: "terminal",
      launchAgentId: "codex",
      runtimeAgentId: "codex",
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
    mockManaged.launchAgentId = "claude";
    mockManaged.runtimeAgentId = "claude";

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
    mockManaged.launchAgentId = undefined;
    mockManaged.runtimeAgentId = undefined;

    new TerminalParserHandler(mockManaged);
    expect(escHandlers).toHaveLength(0);
    // 1 alt screen exit (?l) + 2 dynamic agent blockers (?h).
    expect(csiHandlers).toHaveLength(3);
    const dynamicBlockers = csiHandlers.filter(
      (h) => h.opts.prefix === "?" && h.opts.final === "h"
    );
    expect(dynamicBlockers.some((h) => h.handler([1049]))).toBe(false);
    expect(dynamicBlockers.some((h) => h.handler([1000]))).toBe(false);
    // OSC 52 clipboard block + OSC 57301 data-loss marker apply
    // unconditionally to all terminal kinds.
    expect(oscHandlers).toHaveLength(2);
    expect(oscHandlers.map((h) => h.ident).sort()).toEqual([52, 57301]);
  });

  it("should NOT block alt screen for OpenCode agent", () => {
    mockManaged.launchAgentId = "opencode";
    mockManaged.runtimeAgentId = "opencode";

    new TerminalParserHandler(mockManaged);

    const dynamicBlockers = csiHandlers.filter(
      (h) => h.opts.prefix === "?" && h.opts.final === "h"
    );
    expect(dynamicBlockers).not.toHaveLength(0);
    expect(dynamicBlockers.some((h) => h.handler([1049]))).toBe(false);
  });

  it("should register alt screen blocker for Codex agent (blockAltScreen: true)", () => {
    mockManaged.launchAgentId = "codex";
    mockManaged.runtimeAgentId = "codex";

    new TerminalParserHandler(mockManaged);

    const dynamicBlockers = csiHandlers.filter(
      (h) => h.opts.prefix === "?" && h.opts.final === "h"
    );
    expect(dynamicBlockers.some((h) => h.handler([1049]))).toBe(true);
  });

  it("starts blocking when a regular terminal is runtime-promoted", () => {
    mockManaged.launchAgentId = undefined;
    mockManaged.runtimeAgentId = undefined;

    new TerminalParserHandler(mockManaged);

    const dynamicBlockers = csiHandlers.filter(
      (h) => h.opts.prefix === "?" && h.opts.final === "h"
    );
    expect(dynamicBlockers.some((h) => h.handler([1049]))).toBe(false);

    mockManaged.runtimeAgentId = "codex";

    expect(dynamicBlockers.some((h) => h.handler([1049]))).toBe(true);
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
    mockManaged.launchAgentId = undefined;
    mockManaged.runtimeAgentId = undefined;

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

  describe("OSC 57301 data-loss marker", () => {
    it("registers the OSC 57301 handler unconditionally", () => {
      new TerminalParserHandler(mockManaged);
      const osc = oscHandlers.find((h) => h.ident === 57301);
      expect(osc).toBeDefined();
    });

    it("parses a valid payload and fires onDataLoss with the byte count", () => {
      const onDataLoss = vi.fn();
      new TerminalParserHandler(mockManaged, undefined, onDataLoss);
      const osc = oscHandlers.find((h) => h.ident === 57301);

      expect(osc.handler("1234;backpressure")).toBe(true);
      expect(onDataLoss).toHaveBeenCalledWith(1234);
      expect(onDataLoss).toHaveBeenCalledTimes(1);
    });

    it("fires onDataLoss with 0 when no bytes were counted", () => {
      const onDataLoss = vi.fn();
      new TerminalParserHandler(mockManaged, undefined, onDataLoss);
      const osc = oscHandlers.find((h) => h.ident === 57301);

      expect(osc.handler("0;backpressure")).toBe(true);
      expect(onDataLoss).toHaveBeenCalledWith(0);
    });

    it("consumes but ignores malformed payloads", () => {
      const onDataLoss = vi.fn();
      new TerminalParserHandler(mockManaged, undefined, onDataLoss);
      const osc = oscHandlers.find((h) => h.ident === 57301);

      const malformed = [
        "abc;backpressure",
        "-1;backpressure",
        "",
        "1234",
        "1.5;x",
        // Number() would coerce these; strict decimal parsing must reject them.
        "0x10;backpressure",
        "1e3;backpressure",
        "+1;backpressure",
        " ;backpressure",
        ";backpressure",
      ];
      for (const bad of malformed) {
        expect(osc.handler(bad)).toBe(true);
      }
      expect(onDataLoss).not.toHaveBeenCalled();
    });

    it("does not throw when no onDataLoss callback is provided", () => {
      new TerminalParserHandler(mockManaged);
      const osc = oscHandlers.find((h) => h.ident === 57301);
      expect(() => osc.handler("1234;backpressure")).not.toThrow();
      expect(osc.handler("1234;backpressure")).toBe(true);
    });

    it("disposes the OSC 57301 handler", () => {
      const handler = new TerminalParserHandler(mockManaged);
      const osc = oscHandlers.find((h) => h.ident === 57301);
      handler.dispose();
      expect(osc.disposable.dispose).toHaveBeenCalled();
    });
  });
});
