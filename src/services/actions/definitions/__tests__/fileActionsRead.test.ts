import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const readMock = vi.hoisted(() => vi.fn());

vi.mock("@/store", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/clients", () => ({ systemClient: {} }));
vi.mock("@/clients/filesClient", () => ({ filesClient: { read: readMock } }));

import { registerFileActions } from "../fileActions";

function setupRead(worktreePaths: string[] = []) {
  const actions: ActionRegistry = new Map();
  const callbacks = {
    getWorktrees: () => worktreePaths.map((p, i) => ({ id: `wt-${i}`, path: p })),
  } as unknown as ActionCallbacks;
  registerFileActions(actions, callbacks);
  return async (args?: unknown): Promise<unknown> => {
    const factory = actions.get("file.read");
    if (!factory) throw new Error("missing file.read");
    const def = factory() as AnyActionDefinition;
    return def.run(args, {} as never);
  };
}

function setProjectPath(path: string | undefined) {
  projectStoreMock.getState.mockReturnValue({
    currentProject: path ? { id: "proj", path } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readMock.mockResolvedValue({ content: "file body" });
  setProjectPath("/repo");
});

describe("file.read containment", () => {
  it("reads a repo-relative path against the project root", async () => {
    const run = setupRead();
    const result = await run({ path: "docs/spec.md" });

    expect(readMock).toHaveBeenCalledWith({ path: "/repo/docs/spec.md", rootPath: "/repo" });
    expect(result).toEqual({ content: "file body" });
  });

  it("reads an absolute path inside a worktree using the worktree as root", async () => {
    const run = setupRead(["/worktrees/feature-x"]);
    await run({ path: "/worktrees/feature-x/notes.md" });

    expect(readMock).toHaveBeenCalledWith({
      path: "/worktrees/feature-x/notes.md",
      rootPath: "/worktrees/feature-x",
    });
  });

  it("rejects an absolute path outside the project and its worktrees", async () => {
    const run = setupRead(["/worktrees/feature-x"]);
    await expect(run({ path: "/Users/someone/.ssh/id_rsa" })).rejects.toThrow(
      /outside the current project/
    );
    expect(readMock).not.toHaveBeenCalled();
  });

  it("rejects a prefix-sibling of the project root", async () => {
    const run = setupRead();
    await expect(run({ path: "/repo-evil/secret.md" })).rejects.toThrow(
      /outside the current project/
    );
    expect(readMock).not.toHaveBeenCalled();
  });

  it("rejects traversal that resolves outside the project", async () => {
    const run = setupRead();
    await expect(run({ path: "../../etc/passwd" })).rejects.toThrow(/outside the current project/);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied rootPath that is not a known root", async () => {
    const run = setupRead();
    await expect(run({ path: "id_rsa", rootPath: "/Users/someone/.ssh" })).rejects.toThrow(
      /outside the current project/
    );
    expect(readMock).not.toHaveBeenCalled();
  });

  it("throws for a relative path with no project open and no rootPath", async () => {
    setProjectPath(undefined);
    const run = setupRead();
    await expect(run({ path: "docs/spec.md" })).rejects.toThrow(/No project open/);
  });
});
