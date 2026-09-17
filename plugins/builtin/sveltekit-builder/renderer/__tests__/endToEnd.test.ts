import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SiteGuestEvent,
  SiteGuestNodeObservation,
  SitePreviewBindingState,
  SitePreviewMode,
  SitePreviewPushPayload,
} from "@shared/types/ipc/sitePreview";
import { activate } from "../../main/index.js";
import { createSandbox, createTestHost, type Sandbox } from "../../main/__tests__/testHost.js";
import { InspectorController, type InspectorDeps } from "../inspectorController.js";

/**
 * The panel controller and plugin main were written in parallel against the
 * same protocol, each tested against a mock of the other. This drives the real
 * controller into the real main over real files — the only place a mismatch in
 * range conventions, path forms or state sequencing actually shows up.
 *
 * The preview itself is simulated at its IPC surface: a CDP guest cannot run
 * here, and its half is covered by the guest/host integration test.
 */

const PREVIEW_PANEL = "preview-1";
const PREVIEW_SESSION = "preview-session-1";

let sandbox: Sandbox | null = null;
afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = null;
});

async function setUp() {
  sandbox = await createSandbox();
  const test = createTestHost(sandbox.worktree);
  await activate(test.host);

  let emit: (payload: SitePreviewPushPayload) => void = () => {};
  let mode: SitePreviewMode = "browse";
  const bound = (): SitePreviewBindingState => ({
    sessionId: PREVIEW_SESSION,
    panelId: PREVIEW_PANEL,
    projectId: "p1",
    documentEpoch: 0,
    mode,
    guestReady: true,
    droppedMessages: 0,
  });

  let id = 0;
  const deps: InspectorDeps = {
    sitePreview: {
      listCandidates: async () => [
        { panelId: PREVIEW_PANEL, url: "http://site", boundSessionId: null },
      ],
      bind: async (request) => {
        mode = request.mode ?? mode;
        return bound();
      },
      detach: async () => {},
      setMode: async (request) => {
        mode = request.mode;
        return bound();
      },
      reselect: async () => false,
      clearSelection: async () => undefined,
      getState: async () => bound(),
      onEvent: (callback) => {
        emit = callback;
        return () => {};
      },
    },
    invoke: (channel, args) => test.invoke(channel, args),
    on: () => () => {},
    runtimeSource: async () => "",
    now: () => Date.now(),
  };

  const controller = new InspectorController(PREVIEW_PANEL, deps);
  controller.updateContext({ projectId: "p1", worktreeId: "w1", worktreePath: sandbox.worktree });

  const guest = (event: SiteGuestEvent) =>
    emit({
      kind: "guest-event",
      sessionId: PREVIEW_SESSION,
      panelId: PREVIEW_PANEL,
      projectId: "p1",
      documentEpoch: 0,
      sequence: id++,
      event,
    });

  return { controller, guest, sandbox, invoke: test.invoke };
}

function observation(file: string, source: string, marker: string): SiteGuestNodeObservation {
  const offset = source.indexOf(marker);
  const before = source.slice(0, offset);
  // The tag is the marker's first word; the rest only disambiguates the element.
  const tag = marker.slice(1).split(/[\s>]/)[0]!;
  return {
    runtimeOccurrenceId: `occ-${offset}`,
    loc: { file, line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) },
    ancestry: [],
    tagName: tag.toUpperCase(),
    sameLocCount: 1,
    label: tag,
    bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
    unmapped: false,
  };
}

async function selectInPage(
  env: Awaited<ReturnType<typeof setUp>>,
  appRelative: string,
  marker: string
) {
  const { controller, guest, sandbox: box } = env;
  await vi.waitFor(() => {
    expect(controller.getSnapshot().binding.status).toBe("bound");
    expect(controller.getSnapshot().workspace.status).toBe("ready");
  });
  guest({
    type: "documentReady",
    routeId: "/",
    url: "http://site/",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  });
  const source = await fs.readFile(box.file(appRelative), "utf8");
  guest({ type: "selectionChanged", nodes: [observation(appRelative, source, marker)] });
  await vi.waitFor(() => {
    const snapshot = controller.getSnapshot();
    expect(snapshot.selection.status).toBe("ready");
  });
  const selection = controller.getSnapshot().selection;
  if (selection.status !== "ready") throw new Error("selection did not resolve");
  return { selectionId: selection.selection.selectionId, source };
}

describe("Site Builder end to end: view controller → plugin main → disk", () => {
  it("resolves a clicked element to the exact markup that defines it", async () => {
    const env = await setUp();
    const { source } = await selectInPage(env, "src/lib/native.svelte", "<section");

    const selection = env.controller.getSnapshot().selection;
    if (selection.status !== "ready") throw new Error("selection did not resolve");
    expect(selection.file).toBe("apps/site/src/lib/native.svelte");
    const definition = selection.selection.nodes[0]!.definition!;
    expect(source.slice(definition.range.start, definition.range.end)).toBe(
      source.slice(source.indexOf("<section"), source.lastIndexOf("</section>") + 10)
    );
    expect(definition.revision).toBe(createHash("sha256").update(source, "utf8").digest("hex"));
  });

  it("holds the selection to the bytes it was resolved against", async () => {
    const env = await setUp();
    await selectInPage(env, "src/lib/native.svelte", "<section");
    const selection = env.controller.getSnapshot().selection;
    if (selection.status !== "ready") throw new Error("selection did not resolve");
    await vi.waitFor(() => {
      const current = env.controller.getSnapshot().selection;
      expect(current.status === "ready" && current.revisions).not.toBeNull();
    });
    const ready = env.controller.getSnapshot().selection;
    if (ready.status !== "ready" || ready.revisions === null) throw new Error("no revisions");

    await expect(env.controller.sourcesUnchanged(ready.selection, ready.revisions)).resolves.toBe(
      true
    );

    // What an agent writing to the file looks like from here: main reads the
    // bytes again and the claims the request would make no longer hold.
    await fs.writeFile(
      env.sandbox.file("src/lib/native.svelte"),
      '<section class="flex">changed</section>\n'
    );
    await expect(env.controller.sourcesUnchanged(ready.selection, ready.revisions)).resolves.toBe(
      false
    );
  });

  it("reopens its workspace after main closed it, and resolves again", async () => {
    const env = await setUp();
    await selectInPage(env, "src/lib/native.svelte", "<section");
    const before = env.controller.getSnapshot().workspace;
    if (before.status !== "ready") throw new Error("workspace not ready");
    await env.invoke("workspace-close", { workspaceSessionId: before.workspaceSessionId });

    const source = await fs.readFile(env.sandbox.file("src/lib/native.svelte"), "utf8");
    env.guest({
      type: "selectionChanged",
      nodes: [observation("src/lib/native.svelte", source, "<section")],
    });
    await vi.waitFor(() => {
      const workspace = env.controller.getSnapshot().workspace;
      expect(workspace.status).toBe("ready");
      if (workspace.status === "ready") {
        expect(workspace.workspaceSessionId).not.toBe(before.workspaceSessionId);
      }
    });

    await selectInPage(env, "src/lib/native.svelte", "<section");
    expect(env.controller.getSnapshot().selection.status).toBe("ready");
  });
});
