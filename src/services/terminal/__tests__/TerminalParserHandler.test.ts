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
      agentId: "claude-1",
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
    const decstrHandler = csiHandlers.find((h) => h.opts.prefix === "!" && h.opts.final === "p");
    expect(decstrHandler).toBeDefined();

    const result = decstrHandler.handler();
    expect(result).toBe(true); // Should block
  });

  it("should NOT block for regular terminals", () => {
    mockManaged.kind = "terminal";
    mockManaged.agentId = undefined;

    new TerminalParserHandler(mockManaged);

    const risHandler = escHandlers.find((h) => h.opts.final === "c");
    expect(risHandler.handler()).toBe(false); // Should pass through

    const decstrHandler = csiHandlers.find((h) => h.opts.prefix === "!" && h.opts.final === "p");
    expect(decstrHandler.handler()).toBe(false); // Should pass through
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
