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
import { CHANNELS } from "../../shared/protocol.js";
import { createSandbox, createTestHost, type Sandbox } from "./testHost.js";

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
});
