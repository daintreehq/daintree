import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const clipboardMock = vi.hoisted(() => ({
  writeBuffer: vi.fn(),
  writeText: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn(() => null),
  getProjectSettings: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  clipboard: clipboardMock,
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

import { CHANNELS } from "../../channels.js";
import { registerCopyTreeHandlers, mergeCopyTreeOptions } from "../copyTree.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("copyTree handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerCopyTreeHandlers({
      mainWindow: {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: vi.fn(),
        },
      },
      ptyClient: {
        hasTerminal: vi.fn(() => false),
        write: vi.fn(),
      },
      worktreeService: undefined,
    } as never);
  });

  it("returns validation errors instead of throwing for invalid generate payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await expect(handler({} as never, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Invalid payload"),
      })
    );
  });

  it("returns validation errors instead of throwing for invalid generate-and-copy payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE);

    await expect(handler({} as never, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Invalid payload"),
      })
    );
  });

  it("returns validation errors instead of throwing for invalid inject payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_INJECT);

    await expect(handler({} as never, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Invalid payload"),
      })
    );
  });

  it("returns validation errors instead of throwing for invalid test-config payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_TEST_CONFIG);

    await expect(handler({} as never, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Invalid payload"),
      })
    );
  });
});

describe("mergeCopyTreeOptions", () => {
  it("combines project excluded paths when runtime exclude is not provided", () => {
    const result = mergeCopyTreeOptions(
      {
        excludedPaths: ["node_modules", ".cache"],
        copyTreeSettings: {
          alwaysExclude: ["dist"],
        } as never,
      },
      { maxFileSize: 1024 }
    );

    expect(result.exclude).toEqual(["node_modules", ".cache", "dist"]);
    expect(result.maxFileSize).toBe(1024);
  });

  it("does not override runtime exclude with project defaults", () => {
    const result = mergeCopyTreeOptions(
      {
        excludedPaths: ["node_modules"],
        copyTreeSettings: {
          alwaysExclude: ["dist"],
        } as never,
      },
      { exclude: ["runtime-only"] }
    );

    expect(result.exclude).toEqual(["runtime-only"]);
  });

  it("applies project defaults only when runtime values are unset", () => {
    const result = mergeCopyTreeOptions(
      {
        excludedPaths: ["node_modules"],
        copyTreeSettings: {
          maxContextSize: 1000,
          maxFileSize: 2000,
          charLimit: 3000,
          strategy: "modified",
          alwaysInclude: ["README.md"],
        } as never,
      },
      {
        maxTotalSize: 9999,
        sort: "name",
      }
    );

    expect(result.maxTotalSize).toBe(9999);
    expect(result.maxFileSize).toBe(2000);
    expect(result.charLimit).toBe(3000);
    expect(result.sort).toBe("name");
    expect(result.always).toEqual(["README.md"]);
  });
});
