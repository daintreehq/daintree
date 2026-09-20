import { afterEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ compiler: false, sourceModel: false }));

vi.mock("svelte/compiler", async (importOriginal) => {
  loaded.compiler = true;
  return importOriginal();
});
vi.mock("@daintreehq/svelte-source-model", async (importOriginal) => {
  loaded.sourceModel = true;
  return importOriginal();
});

import { activate } from "../index.js";
import { BUILDER_TOOL_ID, CHANNELS } from "../../shared/protocol.js";
import manifest from "../../plugin.json" with { type: "json" };
import { createSandbox, createTestHost, type Sandbox } from "./testHost.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let sandbox: Sandbox | null = null;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = null;
});

describe("activate", () => {
  it("registers every protocol channel without loading the compiler or the source model", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);

    await activate(test.host);

    expect(test.channels().sort()).toEqual(Object.values(CHANNELS).sort());
    expect(loaded).toEqual({ compiler: false, sourceModel: false });
    // Activation reads nothing: the project scan belongs to workspaceOpen.
    expect(test.reads).toEqual([]);

    // The first selection is what pays for them.
    const open = await test.invoke<{ workspaceSessionId: string }>(CHANNELS.workspaceOpen, {
      projectId: "p1",
      worktreeId: "w1",
      worktreePath: sandbox.worktree,
      previewPanelId: "preview-1",
    });
    await test.invoke(CHANNELS.selectionResolve, {
      workspaceSessionId: open.workspaceSessionId,
      previewPanelId: "preview-1",
      documentEpoch: 1,
      routeId: "/",
      url: "http://localhost:5173/",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      nodes: [
        {
          runtimeOccurrenceId: "n1",
          loc: { file: "src/routes/+page.svelte", line: 1, column: 0 },
          ancestry: [],
          tagName: "H1",
          sameLocCount: 1,
          label: "h1",
          bounds: [],
          unmapped: false,
        },
      ],
    });
    expect(loaded).toEqual({ compiler: true, sourceModel: true });
  });

  it("binds the workspace filesystem to the project and worktree it was opened for", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);
    await activate(test.host);

    await test.invoke(CHANNELS.workspaceOpen, {
      projectId: "p1",
      worktreeId: "w1",
      worktreePath: sandbox.worktree,
      previewPanelId: "preview-1",
    });

    // Exactly the scope the view named — not the focused window's, and asked
    // for once so the workspace holds one handle for its lifetime.
    expect(test.scopes).toEqual([{ projectId: "p1", worktreeId: "w1" }]);
    // And the workspace genuinely reads through that handle: a scan still
    // going through the ambient `host.fs` would follow the focused window.
    expect(test.readsVia.some((read) => read.via === "scoped")).toBe(true);
    expect(test.readsVia.filter((read) => read.via === "ambient")).toEqual([]);
  });

  it("keeps later workspace reads on the workspace's own handle", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);
    await activate(test.host);

    const open = await test.invoke<{ workspaceSessionId: string }>(CHANNELS.workspaceOpen, {
      projectId: "p1",
      worktreeId: "w1",
      worktreePath: sandbox.worktree,
      previewPanelId: "preview-1",
    });
    test.readsVia.length = 0;
    await test.invoke(CHANNELS.projectModel, { workspaceSessionId: open.workspaceSessionId });

    expect(test.readsVia.length).toBeGreaterThan(0);
    expect(test.readsVia.filter((read) => read.via === "ambient")).toEqual([]);
  });

  it("refuses a session id held by a view of another project", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);
    await activate(test.host);

    const open = await test.invoke<{ workspaceSessionId: string }>(CHANNELS.workspaceOpen, {
      projectId: "p1",
      worktreeId: "w1",
      worktreePath: sandbox.worktree,
      previewPanelId: "preview-1",
    });

    // A session id travels in pushes; holding one must not let another
    // project's view read through this workspace's pinned filesystem.
    await expect(
      test.invoke(
        CHANNELS.projectModel,
        { workspaceSessionId: open.workspaceSessionId },
        { projectId: "p2" }
      )
    ).rejects.toThrow(/WORKSPACE_FORBIDDEN/);
    await expect(
      test.invoke(
        CHANNELS.workspaceClose,
        { workspaceSessionId: open.workspaceSessionId },
        { projectId: "p2" }
      )
    ).rejects.toThrow(/WORKSPACE_FORBIDDEN/);
  });

  it("scans for apps through the workspace the caller named, not the ambient handle", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);
    await activate(test.host);

    const result = await test.invoke<{ appCount: number }>(CHANNELS.detectApps, {
      projectId: "p1",
      worktreeId: "w1",
      worktreePath: sandbox.worktree,
    });

    expect(result.appCount).toBe(1);
    expect(test.scopes).toEqual([{ projectId: "p1", worktreeId: "w1" }]);
    // The ambient handle follows the focused window, so a background worktree
    // reads as having no app if discovery goes through it.
    expect(test.readsVia.some((read) => read.via === "scoped")).toBe(true);
    expect(test.readsVia.filter((read) => read.via === "ambient")).toEqual([]);
  });

  it("scans the worktree the caller named, not the sender window's active one", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);
    await activate(test.host);

    // The context reports the ACTIVE worktree; a preview sitting on a
    // background worktree names a different one, and that is the one scanned.
    await test.invoke(
      CHANNELS.detectApps,
      { projectId: "p1", worktreeId: "w1", worktreePath: sandbox.worktree },
      { worktreeId: "w2" }
    );

    expect(test.scopes).toEqual([{ projectId: "p1", worktreeId: "w1" }]);
  });

  it("refuses an app scan on a project other than the invoking view's", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);
    await activate(test.host);

    await expect(
      test.invoke(
        CHANNELS.detectApps,
        { projectId: "p2", worktreeId: "w1", worktreePath: sandbox.worktree },
        { projectId: "p1" }
      )
    ).rejects.toThrow(/WORKSPACE_FORBIDDEN/);
    expect(test.scopes).toEqual([]);
    expect(test.reads).toEqual([]);
  });

  it("refuses a workspace on a project other than the invoking view's", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);
    await activate(test.host);

    await expect(
      test.invoke(
        CHANNELS.workspaceOpen,
        {
          projectId: "p2",
          worktreeId: "w1",
          worktreePath: sandbox.worktree,
          previewPanelId: "preview-1",
        },
        { projectId: "p1" }
      )
    ).rejects.toThrow(/WORKSPACE_FORBIDDEN/);
    // No scope was requested, so no filesystem authority was minted.
    expect(test.scopes).toEqual([]);
  });

  it("implements every command the manifest declares, and the inspector command opens the panel", async () => {
    sandbox = await createSandbox();
    const test = createTestHost(sandbox.worktree);
    await activate(test.host);

    const mock = test.host as unknown as {
      registeredActions: ReadonlyArray<{
        descriptor: { id: string };
        handler: (args?: unknown) => unknown;
      }>;
      dispatchedActions: ReadonlyArray<{ actionId: string; args: unknown }>;
    };
    const registered = mock.registeredActions.map((action) =>
      action.descriptor.id.split(".").pop()
    );
    for (const command of manifest.contributes.commands) {
      expect(registered).toContain(command.id);
    }

    const toggle = mock.registeredActions.find((action) =>
      action.descriptor.id.endsWith("toggle-builder")
    );
    await toggle?.handler();
    expect(mock.dispatchedActions).toContainEqual({
      actionId: "devPreview.toggleTool",
      args: { toolId: BUILDER_TOOL_ID },
    });
  });
  /**
   * The walk stops at its depth budget, so an app below that budget is never
   * reached. What must not happen is the handlers turning "did not finish"
   * into "there is nothing here" — a claim about the worktree the scan never
   * earned.
   */
  it("says a scan that ran out of budget did not finish, rather than calling it no app", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "site-builder-deep-")));
    const worktree = path.join(root, "worktree");
    // Past DEFAULT_MAX_DEPTH, so the walk sees the directory holding it and
    // stops without ever reading its manifest.
    const buried = path.join(worktree, "a", "b", "c", "d", "e", "f");
    await fs.mkdir(buried, { recursive: true });
    await fs.writeFile(
      path.join(worktree, "package.json"),
      JSON.stringify({ name: "root", private: true })
    );
    await fs.writeFile(
      path.join(buried, "package.json"),
      JSON.stringify({ name: "buried", dependencies: { "@sveltejs/kit": "^2.0.0" } })
    );
    sandbox = {
      worktree,
      appRoot: buried,
      cleanup: () => fs.rm(root, { recursive: true, force: true }),
    } as Sandbox;

    const test = createTestHost(worktree);
    await activate(test.host);

    const detected = await test.invoke<{ appCount: number; complete?: boolean }>(
      CHANNELS.detectApps,
      { projectId: "p1", worktreeId: "w1", worktreePath: worktree }
    );
    expect(detected.appCount).toBe(0);
    expect(detected.complete).toBe(false);

    const opened = await test.invoke<{ status: string; scanComplete?: boolean }>(
      CHANNELS.workspaceOpen,
      {
        projectId: "p1",
        worktreeId: "w1",
        worktreePath: worktree,
        previewPanelId: "preview-1",
      }
    );
    expect(opened.status).toBe("no-app");
    expect(opened.scanComplete).toBe(false);
  });
});
