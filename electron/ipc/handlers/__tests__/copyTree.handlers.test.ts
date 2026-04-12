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
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

import { CHANNELS } from "../../channels.js";
import {
  registerCopyTreeHandlers,
  mergeCopyTreeOptions,
  buildRemoteComputeBlock,
} from "../copyTree.js";

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

  const mockEvent = { sender: { id: 1 } } as never;

  it("returns validation errors instead of throwing for invalid generate payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE);

    await expect(handler(mockEvent, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Invalid payload"),
      })
    );
  });

  it("returns validation errors instead of throwing for invalid generate-and-copy payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE);

    await expect(handler(mockEvent, null as never)).resolves.toEqual(
      expect.objectContaining({
        error: expect.stringContaining("Invalid payload"),
      })
    );
  });

  it("returns validation errors instead of throwing for invalid inject payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.COPYTREE_INJECT);

    await expect(handler(mockEvent, null as never)).resolves.toEqual(
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

describe("buildRemoteComputeBlock", () => {
  it("returns empty string when worktree has no resourceStatus", () => {
    const worktree = { resourceStatus: undefined };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toBe("");
  });

  it("includes full Remote Compute block with endpoint and connect command when status is ready", () => {
    const worktree = {
      resourceStatus: {
        provider: "aws",
        lastStatus: "ready",
        endpoint: "ec2-1-2-3-4.compute.amazonaws.com",
      },
      resourceConnectCommand: "ssh -i key.pem root@ec2-1-2-3-4.compute.amazonaws.com",
    };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toContain("## Remote Compute");
    expect(block).toContain("Provider: aws");
    expect(block).toContain("Status: ready");
    expect(block).toContain("Endpoint: ec2-1-2-3-4.compute.amazonaws.com");
    expect(block).toContain(
      "Run remote commands: ssh -i key.pem root@ec2-1-2-3-4.compute.amazonaws.com"
    );
    expect(block).toContain('canopy-remote "<command>"');
  });

  it("includes informational Remote Compute block without connect command when status is provisioning", () => {
    const worktree = {
      resourceStatus: {
        provider: "gcp",
        lastStatus: "provisioning",
      },
      resourceConnectCommand: undefined,
    };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toContain("## Remote Compute");
    expect(block).toContain("Provider: gcp");
    expect(block).toContain("Status: provisioning");
    expect(block).toContain("Resource is not yet available for remote execution");
    expect(block).not.toContain("Run remote commands:");
    expect(block).not.toContain("canopy-remote");
  });

  it("shows error status without connect command when status is error", () => {
    const worktree = {
      resourceStatus: {
        provider: "azure",
        lastStatus: "error",
      },
      resourceConnectCommand: undefined,
    };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toContain("## Remote Compute");
    expect(block).toContain("Provider: azure");
    expect(block).toContain("Status: error");
    expect(block).toContain("Resource is not yet available for remote execution");
  });

  it("uses unknown provider when provider is undefined", () => {
    const worktree = {
      resourceStatus: {
        lastStatus: "provisioning",
      },
      resourceConnectCommand: undefined,
    };
    const block = buildRemoteComputeBlock(worktree);
    expect(block).toContain("Provider: unknown");
  });
});
