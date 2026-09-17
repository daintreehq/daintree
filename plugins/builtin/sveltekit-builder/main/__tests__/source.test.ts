import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { activate } from "../index.js";
import {
  CHANNELS,
  PUSH_CHANNELS,
  type GuestNodeObservation,
  type SelectionResolveResult,
} from "../../shared/protocol.js";
import type { SelectedNode } from "../../shared/model.js";
import { createSandbox, createTestHost, sha, type Sandbox, type TestHost } from "./testHost.js";

const NATIVE = "src/lib/native.svelte";
const NATIVE_IN_WORKTREE = `apps/site/${NATIVE}`;

let sandbox: Sandbox;
let test: TestHost;
let workspaceSessionId: string;

beforeEach(async () => {
  sandbox = await createSandbox();
  test = createTestHost(sandbox.worktree);
  await activate(test.host);
  const open = await test.invoke<{ status: string; workspaceSessionId: string; appRoot: string }>(
    CHANNELS.workspaceOpen,
    {
      projectId: "p1",
      worktreeId: "w1",
      worktreePath: sandbox.worktree,
      previewPanelId: "preview-1",
    }
  );
  expect(open).toMatchObject({ status: "ready", appRoot: sandbox.appRoot });
  workspaceSessionId = open.workspaceSessionId;
});

afterEach(async () => {
  await sandbox.cleanup();
});

function locationOf(source: string, marker: string, file = NATIVE) {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  const before = source.slice(0, offset);
  return {
    file,
    line: before.split("\n").length,
    column: offset - (before.lastIndexOf("\n") + 1),
  };
}

function observation(
  loc: GuestNodeObservation["loc"],
  overrides: Partial<GuestNodeObservation> = {}
): GuestNodeObservation {
  return {
    runtimeOccurrenceId: "n1",
    loc,
    ancestry: [],
    tagName: "DIV",
    sameLocCount: 1,
    label: "node",
    bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
    unmapped: false,
    ...overrides,
  };
}

function resolve(nodes: GuestNodeObservation[]): Promise<SelectionResolveResult> {
  return test.invoke(CHANNELS.selectionResolve, {
    workspaceSessionId,
    previewPanelId: "preview-1",
    documentEpoch: 3,
    routeId: "/",
    url: "http://localhost:5173/pricing?token=abc&plan=pro#frag",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
    nodes,
  });
}

async function selectOne(node: GuestNodeObservation): Promise<SelectedNode> {
  const result = await resolve([node]);
  if (result.status !== "ok") throw new Error("expected a resolved selection");
  return result.selection.nodes[0]!;
}

describe("selectionResolve", () => {
  it("returns the exact element range and the revision of the bytes on disk", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(
      observation(locationOf(source, "<h1"), { sameLocCount: 3, tagName: "H1" })
    );

    const start = source.indexOf("<h1");
    const end = source.indexOf("</h1>") + "</h1>".length;
    expect(node.definition).toEqual({
      location: locationOf(source, "<h1"),
      range: { start, end },
      tagName: "h1",
      revision: sha(await fs.readFile(sandbox.file(NATIVE))),
      renderedOccurrences: 3,
    });
    expect(node.mapping).toBe("definition-only");
  });

  it("assembles the selection from the workspace, not from anything ambient", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const result = await resolve([observation(locationOf(source, "<p"), { tagName: "P" })]);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.selection).toMatchObject({
      workspaceSessionId,
      projectId: "p1",
      worktreeId: "w1",
      appRoot: sandbox.appRoot,
      previewPanelId: "preview-1",
      documentEpoch: 3,
      displayedUrl: "http://localhost:5173/pricing?token=&plan=",
    });
  });

  it("places a hydrated page's misstamped element by its shape, and proves it there", async () => {
    // Svelte's dev walk counted the Header's root while hydrating, so the
    // toolbar div carries the location of the span after it. The shape the
    // guest reports still identifies it; the definition names the true line.
    const file = "src/routes/hydrated.svelte";
    const source = [
      "<script>import Header from '$lib/Header.svelte';</script>",
      "<Header />",
      '<div class="journal">',
      '  <div class="toolbar"><p>September</p></div>',
      "</div>",
      '<div class="end"><span>*</span></div>',
      "",
    ].join("\n");
    await fs.writeFile(sandbox.file(file), source);
    const stamped = locationOf(source, "<span", file);
    const frame = {
      type: "component",
      file: ".svelte-kit/generated/root.svelte",
      line: 56,
      column: 18,
      componentTag: "Pyramid_2",
    };
    const node = await selectOne(
      observation(stamped, {
        ancestry: [frame],
        sameLocCount: 7,
        structure: {
          file,
          path: [
            { tag: "div", index: 0 },
            { tag: "div", index: 0 },
          ],
        },
      })
    );
    expect(node.definition).toMatchObject({
      location: locationOf(source, '<div class="toolbar"', file),
      tagName: "div",
      renderedOccurrences: 1,
      renderedOccurrencesAtLeast: true,
    });
    // Without the shape, the disagreement is reported as what it is.
    expect(await resolve([observation(stamped, { ancestry: [frame] })])).toEqual({
      status: "stale",
      mismatch: { ...stamped, reported: "div", found: "span" },
    });
    // A shape the source cannot follow leaves the disagreement as it was.
    expect(
      await resolve([
        observation(stamped, {
          ancestry: [frame],
          structure: { file, path: [{ tag: "div", index: 4 }] },
        }),
      ])
    ).toEqual({ status: "stale", mismatch: { ...stamped, reported: "div", found: "span" } });
  });

  it("keeps a stamp the file agrees with, whatever the shape says", async () => {
    // The page can move an element after stamping it; its new place says
    // nothing about its source. So a stamp that resolves cleanly is the
    // answer, and the shape is consulted only when the file contradicts it —
    // which also means a neighbour's stamp of the same tag goes unseen here.
    const file = "src/routes/twins.svelte";
    const source = [
      "<script>import Header from '$lib/Header.svelte';</script>",
      "<Header />",
      '<section class="one"><p>1</p></section>',
      '<section class="two"><p>2</p></section>',
      "",
    ].join("\n");
    await fs.writeFile(sandbox.file(file), source);
    const frame = {
      type: "component",
      file: ".svelte-kit/generated/root.svelte",
      line: 5,
      column: 0,
    };
    const node = await selectOne(
      observation(locationOf(source, '<section class="two"', file), {
        ancestry: [frame],
        tagName: "SECTION",
        sameLocCount: 3,
        structure: { file, path: [{ tag: "section", index: 0 }] },
      })
    );
    expect(node.definition).toMatchObject({
      location: locationOf(source, '<section class="two"', file),
      renderedOccurrences: 3,
    });
  });

  it("places an element the page could not stamp at all, by its shape", async () => {
    const file = "src/routes/tail.svelte";
    const source = [
      "<script>import Header from '$lib/Header.svelte';</script>",
      "<Header />",
      '<div class="toolbar"><p class="label">September</p></div>',
      "",
    ].join("\n");
    await fs.writeFile(sandbox.file(file), source);
    const frame = {
      type: "component",
      file: ".svelte-kit/generated/root.svelte",
      line: 5,
      column: 0,
    };
    const node = await selectOne(
      observation(null, {
        ancestry: [frame],
        tagName: "P",
        structure: {
          file,
          path: [
            { tag: "div", index: 0 },
            { tag: "p", index: 0 },
          ],
        },
      })
    );
    expect(node.definition).toMatchObject({
      location: locationOf(source, '<p class="label"', file),
      tagName: "p",
      renderedOccurrences: 1,
      renderedOccurrencesAtLeast: true,
    });
    expect(node.mapping).toBe("definition-only");
  });

  it("returns stale when the location no longer lands on an element, never a neighbour", async () => {
    const original = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const captured = locationOf(original, "<h1");
    // An agent inserts a line above: the captured line/column now points into
    // the `<section` line, one line up from the heading.
    await fs.writeFile(sandbox.file(NATIVE), `<!-- banner -->\n${original}`);

    // Stale, and said as what it is — nothing starts where the page pointed —
    // so the inspector can tell a location the page got wrong from a document
    // that moved on, rather than reporting both as "the page changed".
    expect(await resolve([observation(captured, { tagName: "H1" })])).toEqual({
      status: "stale",
      mismatch: { ...captured, reported: "h1", found: null },
    });
    expect(
      await resolve([observation({ ...captured, column: captured.column + 1 }, { tagName: "H1" })])
    ).toEqual({
      status: "stale",
      mismatch: { ...captured, column: captured.column + 1, reported: "h1", found: null },
    });
  });

  it("refuses a guest path that escapes the app root, without reading it", async () => {
    for (const file of [
      "../../packages/ui/Button.svelte",
      "src/../../../packages/ui/Button.svelte",
      "../../../outside.svelte",
      `${sandbox.root}/outside.svelte`,
    ]) {
      const node = await selectOne(observation({ file, line: 1, column: 0 }));
      expect(node.definition).toBeNull();
      expect(node.mapping).toBe("visual-only");
    }
    const componentReads = test.reads.filter((read) => read.endsWith(".svelte"));
    expect(componentReads.every((read) => read.startsWith(`${sandbox.appRoot}/`))).toBe(true);
    expect(test.reads.some((read) => read.endsWith("Button.svelte"))).toBe(false);
    expect(test.reads.some((read) => read.endsWith("outside.svelte"))).toBe(false);
  });

  it("refuses a path that reaches outside the app through a symlinked directory", async () => {
    await fs.symlink(`${sandbox.worktree}/packages/ui`, sandbox.file("src/shared"), "dir");
    const node = await selectOne(
      observation({ file: "src/shared/Button.svelte", line: 1, column: 0 }, { tagName: "BUTTON" })
    );
    expect(node.definition).toBeNull();
    expect(node.mapping).toBe("visual-only");
  });

  it("returns stale when the location now lands on an element with a different tag", async () => {
    const original = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const captured = locationOf(original, "<p");
    await fs.writeFile(
      sandbox.file(NATIVE),
      original.replace("<p", "<h3").replace("</p>", "</h3>")
    );
    expect(await resolve([observation(captured, { tagName: "P" })])).toEqual({
      status: "stale",
      mismatch: { ...captured, reported: "p", found: "h3" },
    });
  });

  it("refuses a generated file", async () => {
    const node = await selectOne(
      observation({ file: ".svelte-kit/generated/root.svelte", line: 1, column: 0 })
    );
    expect(node.definition).toBeNull();
    expect(node.mapping).toBe("visual-only");
    expect(test.reads.some((read) => read.includes(".svelte-kit"))).toBe(false);
  });

  it("maps unmapped content to visual-only", async () => {
    const node = await selectOne(observation(null, { unmapped: true }));
    expect(node.mapping).toBe("visual-only");
    expect(node.definition).toBeNull();
  });
});

describe("sourceChanged", () => {
  it("pushes an external change to a file the workspace read, addressed to its preview", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const fire = () => {
      for (const watcher of [...test.watchers]) watcher.callback(sandbox.file(NATIVE));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    // An unchanged file is not a change, however many events the watcher sends.
    fire();
    await settle();
    expect(test.pushes().filter((push) => push.channel === PUSH_CHANNELS.sourceChanged)).toEqual(
      []
    );

    const external = `${source}\n<!-- agent -->\n`;
    await fs.writeFile(sandbox.file(NATIVE), external);
    fire();
    await settle();
    expect(test.pushes().filter((push) => push.channel === PUSH_CHANNELS.sourceChanged)).toEqual([
      {
        channel: PUSH_CHANNELS.sourceChanged,
        payload: { workspaceSessionId, file: NATIVE_IN_WORKTREE, revision: sha(external) },
        panelId: "preview-1",
      },
    ]);
  });
});

describe("byte order mark", () => {
  it("resolves against BOM-free offsets while the bytes keep the BOM", async () => {
    const file = "src/lib/bom.svelte";
    const original = '\uFEFF<h1 class="title">Hello</h1>\n';
    await fs.writeFile(sandbox.file(file), original, "utf8");
    const originalBytes = await fs.readFile(sandbox.file(file));
    expect([...originalBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const node = await selectOne(observation({ file, line: 1, column: 0 }, { tagName: "H1" }));
    expect(node.definition?.range).toEqual({ start: 0, end: original.length - 2 });
    expect(node.definition?.revision).toBe(sha(originalBytes));
  });

  it("keeps a second leading U+FEFF as content", async () => {
    const file = "src/lib/double-bom.svelte";
    await fs.writeFile(sandbox.file(file), "\uFEFF\uFEFF<h1>Hello</h1>\n", "utf8");
    // What Svelte's dev runtime reports: one BOM removed, the second is column 0's content.
    const node = await selectOne(observation({ file, line: 1, column: 1 }, { tagName: "H1" }));
    expect(node.definition?.tagName).toBe("h1");
  });
});
