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

  it("should register handlers on initialization", () => {
    new TerminalParserHandler(mockManaged);
    expect(mockTerminal.parser.registerEscHandler).toHaveBeenCalled();
    expect(mockTerminal.parser.registerCsiHandler).toHaveBeenCalled();
  });

  it("should block RIS (ESC c) for agent terminals", () => {
    new TerminalParserHandler(mockManaged);
    const risHandler = escHandlers.find((h) => h.opts.final === "c");
    expect(risHandler).toBeDefined();

    // Test blocking
    const result = risHandler.handler();
    expect(result).toBe(true); // Should block
  });

  it("should block DECSTR (CSI ! p) for agent terminals", () => {
    new TerminalParserHandler(mockManaged);
    const decstrHandler = csiHandlers.find(
      (h) => h.opts.intermediates === "!" && h.opts.final === "p"
    );
    expect(decstrHandler).toBeDefined();

    const result = decstrHandler.handler();
    expect(result).toBe(true); // Should block
  });

  it("should block alternate screen toggles for agent terminals", () => {
    new TerminalParserHandler(mockManaged);
    const decset = csiHandlers.find((h) => h.opts.prefix === "?" && h.opts.final === "h");
    const decrst = csiHandlers.find((h) => h.opts.prefix === "?" && h.opts.final === "l");
    expect(decset).toBeDefined();
    expect(decrst).toBeDefined();

    expect(decset.handler([1049])).toBe(true);
    expect(decrst.handler([1049])).toBe(true);
  });

  it("should block cursor-to-top / clear / scroll-region for Claude agent terminals", () => {
    mockManaged.agentId = "claude";
    mockManaged.type = "claude";

    new TerminalParserHandler(mockManaged);

    const decstbm = csiHandlers.find((h) => h.opts.final === "r");
    const ed = csiHandlers.find((h) => h.opts.final === "J");
    const cup = csiHandlers.find((h) => h.opts.final === "H");
    const hvp = csiHandlers.find((h) => h.opts.final === "f");
    const vpa = csiHandlers.find((h) => h.opts.final === "d");

    expect(decstbm).toBeDefined();
    expect(ed).toBeDefined();
    expect(cup).toBeDefined();
    expect(hvp).toBeDefined();
    expect(vpa).toBeDefined();

    expect(decstbm.handler([])).toBe(true);

    expect(ed.handler([2])).toBe(true);
    expect(ed.handler([3])).toBe(true);
    expect(ed.handler([0])).toBe(false);
    expect(ed.handler([])).toBe(false);

    expect(cup.handler([])).toBe(true); // defaults to 1;1
    expect(cup.handler([1, 1])).toBe(true);
    expect(cup.handler([2, 1])).toBe(false);

    expect(hvp.handler([])).toBe(true);
    expect(hvp.handler([1, 1])).toBe(true);
    expect(hvp.handler([2, 1])).toBe(false);

    expect(vpa.handler([])).toBe(true); // defaults to row 1
    expect(vpa.handler([1])).toBe(true);
    expect(vpa.handler([2])).toBe(false);
  });

  it("should NOT block cursor-to-top / clear / scroll-region for Codex agent terminals", () => {
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

    const risHandler = escHandlers.find((h) => h.opts.final === "c");
    expect(risHandler.handler()).toBe(false); // Should pass through

    const decstrHandler = csiHandlers.find(
      (h) => h.opts.intermediates === "!" && h.opts.final === "p"
    );
    expect(decstrHandler.handler()).toBe(false); // Should pass through

    const decset = csiHandlers.find((h) => h.opts.prefix === "?" && h.opts.final === "h");
    const decrst = csiHandlers.find((h) => h.opts.prefix === "?" && h.opts.final === "l");
    if (decset) expect(decset.handler([1049])).toBe(false);
    if (decrst) expect(decrst.handler([1049])).toBe(false);
  });

  it("should dispose handlers correctly", () => {
    const handler = new TerminalParserHandler(mockManaged);
    expect(escHandlers.length).toBeGreaterThan(0);
    expect(csiHandlers.length).toBeGreaterThan(0);

    handler.dispose();

    escHandlers.forEach((h) => expect(h.disposable.dispose).toHaveBeenCalled());
    csiHandlers.forEach((h) => expect(h.disposable.dispose).toHaveBeenCalled());
  });

  it("should allow resets when explicitly allowed (recovery mode)", () => {
    const handler = new TerminalParserHandler(mockManaged);
    const risHandler = escHandlers.find((h) => h.opts.final === "c");

    // Default: block
    expect(risHandler.handler()).toBe(true);

    // Allow
    handler.setAllowResets(true);
    expect(risHandler.handler()).toBe(false); // Pass through

    // Disallow
    handler.setAllowResets(false);
    expect(risHandler.handler()).toBe(true); // Block again
  });

  it("should handle missing parser API gracefully", () => {
    (mockManaged.terminal as any).parser = undefined; // Simulate missing API
    expect(() => new TerminalParserHandler(mockManaged)).not.toThrow();
  });
});
