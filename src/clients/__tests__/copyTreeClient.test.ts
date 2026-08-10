import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let copyTreeClient: typeof import("../copyTreeClient").copyTreeClient;

let generateMock: ReturnType<typeof vi.fn>;
let generateAndCopyFileMock: ReturnType<typeof vi.fn>;
let injectToTerminalMock: ReturnType<typeof vi.fn>;

const RESULT = { success: true, fileCount: 12 };

/**
 * The client is a thin positional wrapper over the preload bindings, and that
 * thinness is exactly what needs guarding: `source` and `name` are both
 * trailing optionals of history metadata, so dropping one or transposing the
 * two is a silent mislabelling rather than a type error — every argument from
 * `options` onward is optional, and `name` and `source` are both strings to
 * TypeScript at the call site (#11734).
 */
describe("copyTreeClient", () => {
  beforeEach(async () => {
    vi.resetModules();

    generateMock = vi.fn().mockResolvedValue(RESULT);
    generateAndCopyFileMock = vi.fn().mockResolvedValue(RESULT);
    injectToTerminalMock = vi.fn().mockResolvedValue(RESULT);

    typedGlobal.window = {
      electron: {
        copyTree: {
          generate: generateMock,
          generateAndCopyFile: generateAndCopyFileMock,
          injectToTerminal: injectToTerminalMock,
        },
      },
    };

    const mod = await import("../copyTreeClient");
    copyTreeClient = mod.copyTreeClient;
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  describe("generate", () => {
    it("forwards the run name after the source", async () => {
      await expect(
        copyTreeClient.generate("wt-1", { modified: true }, true, "mcp", "Auth flow context")
      ).resolves.toEqual(RESULT);

      expect(generateMock).toHaveBeenCalledWith(
        "wt-1",
        { modified: true },
        true,
        "mcp",
        "Auth flow context"
      );
    });

    it("passes the name through undefined when the caller omits it", async () => {
      await copyTreeClient.generate("wt-1", undefined, undefined, "toolbar");

      expect(generateMock).toHaveBeenCalledWith("wt-1", undefined, undefined, "toolbar", undefined);
    });
  });

  describe("generateAndCopyFile", () => {
    it("forwards the run name after the source", async () => {
      await expect(
        copyTreeClient.generateAndCopyFile("wt-1", { modified: true }, "mcp", "Auth flow context")
      ).resolves.toEqual(RESULT);

      expect(generateAndCopyFileMock).toHaveBeenCalledWith(
        "wt-1",
        { modified: true },
        "mcp",
        "Auth flow context"
      );
    });

    it("passes the name through undefined when the caller omits it", async () => {
      await copyTreeClient.generateAndCopyFile("wt-1", undefined, "toolbar");

      expect(generateAndCopyFileMock).toHaveBeenCalledWith("wt-1", undefined, "toolbar", undefined);
    });
  });

  describe("injectToTerminal", () => {
    it("forwards the run name after the source", async () => {
      await expect(
        copyTreeClient.injectToTerminal(
          "t-1",
          "wt-1",
          { modified: true },
          "inj-1",
          "mcp",
          "Auth flow context"
        )
      ).resolves.toEqual(RESULT);

      expect(injectToTerminalMock).toHaveBeenCalledWith(
        "t-1",
        "wt-1",
        { modified: true },
        "inj-1",
        "mcp",
        "Auth flow context"
      );
    });

    it("passes the name through undefined when the caller omits it", async () => {
      await copyTreeClient.injectToTerminal("t-1", "wt-1", undefined, undefined, "terminal");

      expect(injectToTerminalMock).toHaveBeenCalledWith(
        "t-1",
        "wt-1",
        undefined,
        undefined,
        "terminal",
        undefined
      );
    });
  });
});
