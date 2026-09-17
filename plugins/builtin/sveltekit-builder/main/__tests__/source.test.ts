import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { parse as svelteParse } from "svelte/compiler";
import {
  planSetClassTokens,
  resolveElementAtLocation,
  type SvelteParse,
} from "@daintreehq/svelte-source-model";
import { activate } from "../index.js";
import {
  CHANNELS,
  PUSH_CHANNELS,
  type EditApplyResult,
  type GuestNodeObservation,
  type SelectionResolveResult,
} from "../../shared/protocol.js";
import type { EditReceipt, SelectedNode } from "../../shared/model.js";
import { createSandbox, createTestHost, sha, type Sandbox, type TestHost } from "./testHost.js";

const parse = svelteParse as unknown as SvelteParse;
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

function edit(args: Record<string, unknown>): Promise<EditApplyResult> {
  return test.invoke(CHANNELS.editApply, {
    workspaceSessionId,
    affectedOccurrences: 1,
    idempotencyKey: `key-${Math.random()}`,
    ...args,
  });
}

function receiptOf(result: EditApplyResult): EditReceipt {
  if (result.status !== "applied")
    throw new Error(`expected applied, got ${JSON.stringify(result)}`);
  return result.receipt;
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
    expect(node.capabilities).toEqual(
      expect.arrayContaining([
        { surface: "text", support: "direct" },
        { surface: "classes", support: "direct" },
      ])
    );
  });

  it("shows how a surface it won't edit is written, verbatim and bounded", async () => {
    const file = "src/lib/dynamic-classes.svelte";
    const source = await fs.readFile(sandbox.file(file), "utf8");
    const node = await selectOne(
      observation(locationOf(source, "<button class={[", file), { tagName: "BUTTON" })
    );
    expect(node.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "classes", support: "agent-assisted" }),
      ])
    );
    expect(node.surfaces.classes).toBeNull();
    expect(node.written?.classes).toBe('class={["btn", active && "bg-accent"]} class:on={active}');
    // Literal text stays an editable value, not an excerpt.
    expect(node.written?.text ?? null).toBeNull();

    const mixed = await selectOne(
      observation(locationOf(source, '<div class="grid', file), { tagName: "DIV" })
    );
    expect(mixed.written?.classes).toBe(`class="grid {active ? 'gap-2' : 'gap-8'}"`);
  });

  it("takes each class attribute on its own, keeps whitespace, and shows dynamic text", async () => {
    const file = "src/lib/written.svelte";
    const source = [
      "<script>let { a, b, name } = $props();</script>",
      '<p class={a}  data-token="secret" class:on={b}>Hi {name}</p>',
      '<span class={"x  y"}>Fixed</span>',
      "",
    ].join("\n");
    await fs.writeFile(sandbox.file(file), source);
    const paragraph = await selectOne(
      observation(locationOf(source, "<p", file), { tagName: "P" })
    );
    expect(paragraph.written?.classes).toBe("class={a} class:on={b}");
    expect(paragraph.written?.classes).not.toContain("secret");
    expect(paragraph.written?.text).toBe("Hi {name}");

    const span = await selectOne(
      observation(locationOf(source, "<span", file), { tagName: "SPAN" })
    );
    expect(span.written?.classes).toBe('class={"x  y"}');
    // Literal text is still an editable value, not an excerpt.
    expect(span.surfaces.text).toEqual({ text: "Fixed" });
    expect(span.written?.text).toBeNull();
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
      expect(node.capabilities.every((capability) => capability.support === "inspect-only")).toBe(
        true
      );
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
    expect(
      await edit({
        file: "apps/site/src/shared/Button.svelte",
        expectedRevision: sha(await fs.readFile(`${sandbox.worktree}/packages/ui/Button.svelte`)),
        operations: [{ kind: "set_literal_text", range: { start: 0, end: 31 }, text: "x" }],
      })
    ).toMatchObject({ status: "error", code: "OUT_OF_SCOPE" });
    expect(test.writes).toEqual([]);
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
    expect(node.capabilities).toContainEqual({
      surface: "classes",
      support: "inspect-only",
      reason: "generated-file",
    });
    expect(test.reads.some((read) => read.includes(".svelte-kit"))).toBe(false);
  });

  it("maps unmapped content to visual-only", async () => {
    const node = await selectOne(observation(null, { unmapped: true }));
    expect(node.mapping).toBe("visual-only");
    expect(node.capabilities.map((capability) => capability.support)).toEqual([
      "inspect-only",
      "inspect-only",
      "inspect-only",
      "inspect-only",
    ]);
  });
});

describe("editApply", () => {
  it("writes exactly the planned class-token bytes and nothing outside the range", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(
      observation(locationOf(source, "<section"), { tagName: "SECTION" })
    );
    const element = resolveElementAtLocation(source, locationOf(source, "<section"), parse);
    if (element.status !== "resolved" || element.node.classes.support !== "direct") {
      throw new Error("fixture section should have a literal class");
    }
    const plan = planSetClassTokens(source, element.node, { add: ["gap-8"], remove: ["gap-4"] });
    if (plan.status !== "planned") throw new Error("fixture edit should plan");

    const result = await edit({
      file: NATIVE_IN_WORKTREE,
      expectedRevision: node.definition!.revision,
      operations: [
        {
          kind: "set_class_tokens",
          range: element.node.classes.range,
          add: ["gap-8"],
          remove: ["gap-4"],
          responsive: { kind: "base" },
        },
      ],
    });
    const receipt = receiptOf(result);

    const written = await fs.readFile(sandbox.file(NATIVE), "utf8");
    expect(written).toBe(plan.after);
    const { start, end } = element.node.classes.range;
    const delta = written.length - source.length;
    expect(written.slice(0, start)).toBe(source.slice(0, start));
    expect(written.slice(end + delta)).toBe(source.slice(end));

    expect(receipt).toMatchObject({
      file: NATIVE_IN_WORKTREE,
      beforeRevision: sha(source),
      afterRevision: sha(written),
      sourceSaved: true,
      previewRefreshed: null,
      stylesGenerated: null,
    });
    expect(test.writes).toHaveLength(1);
  });

  it("accepts the definition range a selection hands the view", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const result = await edit({
      file: NATIVE_IN_WORKTREE,
      expectedRevision: node.definition!.revision,
      operations: [
        { kind: "set_literal_text", range: node.definition!.range, text: "New & <bold>" },
      ],
    });
    receiptOf(result);
    expect(await fs.readFile(sandbox.file(NATIVE), "utf8")).toContain(
      '<h1 class="text-2xl font-bold">New &amp; &lt;bold&gt;</h1>'
    );
  });

  it("returns conflict for a stale expectedRevision and writes nothing", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const external = source.replace("Literal paragraph text.", "An agent changed this.");
    await fs.writeFile(sandbox.file(NATIVE), external);

    const result = await edit({
      file: NATIVE_IN_WORKTREE,
      expectedRevision: node.definition!.revision,
      operations: [{ kind: "set_literal_text", range: node.definition!.range, text: "Mine" }],
    });

    expect(result).toEqual({ status: "conflict", currentRevision: sha(external) });
    expect(test.writes).toEqual([]);
    expect(await fs.readFile(sandbox.file(NATIVE), "utf8")).toBe(external);
  });

  it("writes once for a retried idempotency key, including a concurrent retry", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const args = {
      file: NATIVE_IN_WORKTREE,
      expectedRevision: node.definition!.revision,
      operations: [{ kind: "set_literal_text", range: node.definition!.range, text: "Once" }],
      idempotencyKey: "retry-me",
    };

    const [first, concurrent] = await Promise.all([edit(args), edit(args)]);
    const later = await edit(args);

    expect(test.writes).toHaveLength(1);
    expect(concurrent).toEqual(first);
    expect(later).toEqual(first);
    receiptOf(first);
  });

  it("refuses a no-op without writing", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const result = await edit({
      file: NATIVE_IN_WORKTREE,
      expectedRevision: node.definition!.revision,
      operations: [
        { kind: "set_literal_text", range: node.definition!.range, text: "Plain literal heading" },
      ],
    });
    expect(result).toEqual({ status: "no-op" });
    expect(test.writes).toEqual([]);
  });

  it("refuses paths outside the app and generated files without writing", async () => {
    const operations = [{ kind: "set_literal_text", range: { start: 0, end: 1 }, text: "x" }];
    const expectedRevision = sha("irrelevant");
    const cases: Array<[string, string]> = [
      ["packages/ui/Button.svelte", "OUT_OF_SCOPE"],
      ["../outside.svelte", "OUT_OF_SCOPE"],
      [`${sandbox.root}/outside.svelte`, "OUT_OF_SCOPE"],
      ["apps/site/.svelte-kit/generated/root.svelte", "GENERATED_FILE"],
    ];
    for (const [file, code] of cases) {
      expect(await edit({ file, expectedRevision, operations })).toMatchObject({
        status: "error",
        code,
      });
    }
    expect(test.writes).toEqual([]);
  });

  it("applies disjoint operations together", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const heading = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const paragraph = await selectOne(observation(locationOf(source, "<p"), { tagName: "P" }));
    receiptOf(
      await edit({
        file: NATIVE_IN_WORKTREE,
        expectedRevision: sha(source),
        operations: [
          { kind: "set_literal_text", range: heading.definition!.range, text: "One" },
          { kind: "set_literal_text", range: paragraph.definition!.range, text: "Two" },
        ],
      })
    );
    const written = await fs.readFile(sandbox.file(NATIVE), "utf8");
    expect(written).toContain(">One</h1>");
    expect(written).toContain(">Two</p>");
  });

  it("refuses two operations on the same slot instead of concatenating them", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const heading = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const operation = (text: string) => ({
      kind: "set_literal_text",
      range: heading.definition!.range,
      text,
    });
    expect(
      await edit({
        file: NATIVE_IN_WORKTREE,
        expectedRevision: sha(source),
        operations: [operation("one"), operation("two")],
      })
    ).toMatchObject({ status: "error" });
    expect(test.writes).toEqual([]);
  });

  it("refuses an operation whose range no element owns", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const start = source.indexOf("Plain literal");
    const result = await edit({
      file: NATIVE_IN_WORKTREE,
      expectedRevision: sha(source),
      // Inside the heading's text, but not the text node's own range.
      operations: [
        { kind: "set_literal_text", range: { start: start + 1, end: start + 5 }, text: "x" },
      ],
    });
    expect(result).toMatchObject({ status: "error", code: "NODE_NOT_FOUND" });
    expect(test.writes).toEqual([]);
  });
});

describe("editUndo", () => {
  async function applyHeadingEdit(): Promise<{ original: string; receipt: EditReceipt }> {
    const original = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(original, "<h1"), { tagName: "H1" }));
    const receipt = receiptOf(
      await edit({
        file: NATIVE_IN_WORKTREE,
        expectedRevision: node.definition!.revision,
        operations: [{ kind: "set_literal_text", range: node.definition!.range, text: "Edited" }],
      })
    );
    return { original, receipt };
  }

  it("restores the original bytes", async () => {
    const { original, receipt } = await applyHeadingEdit();

    const result = await test.invoke<{ status: string; receipt: EditReceipt }>(CHANNELS.editUndo, {
      workspaceSessionId,
      transactionId: receipt.transactionId,
    });

    expect(result.status).toBe("reversed");
    expect(await fs.readFile(sandbox.file(NATIVE), "utf8")).toBe(original);
    expect(result.receipt).toMatchObject({
      beforeRevision: receipt.afterRevision,
      afterRevision: sha(original),
      previewRefreshed: null,
      stylesGenerated: null,
    });
  });

  it("returns superseded after an external write and does not overwrite it", async () => {
    const { receipt } = await applyHeadingEdit();
    const edited = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const external = edited.replace("Pricing", "Plans");
    await fs.writeFile(sandbox.file(NATIVE), external);
    const writesBefore = test.writes.length;

    const result = await test.invoke(CHANNELS.editUndo, {
      workspaceSessionId,
      transactionId: receipt.transactionId,
    });

    expect(result).toEqual({ status: "superseded", currentRevision: sha(external) });
    expect(test.writes).toHaveLength(writesBefore);
    expect(await fs.readFile(sandbox.file(NATIVE), "utf8")).toBe(external);
  });

  it("forgets the journal when the workspace closes", async () => {
    const { receipt } = await applyHeadingEdit();
    await test.invoke(CHANNELS.workspaceClose, { workspaceSessionId });
    expect(
      await test.invoke(CHANNELS.editUndo, {
        workspaceSessionId,
        transactionId: receipt.transactionId,
      })
    ).toMatchObject({ status: "error" });
  });
});

describe("sourceChanged", () => {
  it("pushes an external change to a file the workspace read, but not the builder's own write", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const fire = () => {
      for (const watcher of [...test.watchers]) watcher.callback(sandbox.file(NATIVE));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    receiptOf(
      await edit({
        file: NATIVE_IN_WORKTREE,
        expectedRevision: node.definition!.revision,
        operations: [{ kind: "set_literal_text", range: node.definition!.range, text: "Ours" }],
      })
    );
    fire();
    await settle();
    expect(test.pushes().filter((push) => push.channel === PUSH_CHANNELS.sourceChanged)).toEqual(
      []
    );

    const external = `${await fs.readFile(sandbox.file(NATIVE), "utf8")}\n<!-- agent -->\n`;
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

describe("decoded surfaces", () => {
  it("carries the real class tokens and literal text of a selected element", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    expect(node.surfaces).toEqual({
      classes: { tokens: ["text-2xl", "font-bold"] },
      text: { text: "Plain literal heading" },
    });
  });

  it("offers no value for a surface that is not direct", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(source, "<h2"), { tagName: "H2" }));
    expect(node.surfaces).toEqual({ classes: null, text: null });
  });

  it("decodes entities once, and removes exactly the source token the view named", async () => {
    const file = "src/lib/entities.svelte";
    const source = '<div class="p&#45;4 p&amp;#45;4">A &amp; B</div>\n';
    await fs.writeFile(sandbox.file(file), source);
    const node = await selectOne(observation({ file, line: 1, column: 0 }, { tagName: "DIV" }));
    expect(node.surfaces).toEqual({
      classes: { tokens: ["p-4", "p&#45;4"] },
      text: { text: "A & B" },
    });

    receiptOf(
      await edit({
        file: `apps/site/${file}`,
        expectedRevision: node.definition!.revision,
        operations: [
          {
            kind: "set_class_tokens",
            range: node.definition!.range,
            add: [],
            remove: ["p-4"],
            responsive: { kind: "base" },
          },
        ],
      })
    );
    expect(await fs.readFile(sandbox.file(file), "utf8")).toBe(
      '<div class="p&amp;#45;4">A &amp; B</div>\n'
    );
  });
});

describe("decoded text", () => {
  it("shows text as the compiler decodes it and writes it back without growing a newline or escaping an entity", async () => {
    const file = "src/lib/text.svelte";
    await fs.writeFile(sandbox.file(file), "<pre>\nHi &copy; &#128;</pre>\n");
    const node = await selectOne(observation({ file, line: 1, column: 0 }, { tagName: "PRE" }));
    expect(node.surfaces.text).toEqual({ text: "Hi © €" });

    const result = await edit({
      file: `apps/site/${file}`,
      expectedRevision: node.definition!.revision,
      operations: [
        { kind: "set_literal_text", range: node.definition!.range, text: node.surfaces.text!.text },
      ],
    });
    // The rendered text is unchanged either way; what must not happen is a
    // second leading newline or an escaped `&amp;copy;`.
    const written = await fs.readFile(sandbox.file(file), "utf8");
    expect(written).toContain("Hi © €</pre>");
    expect(written).not.toContain("<pre>\n\n");
    expect(written).not.toContain("&amp;copy;");
    expect(["applied", "no-op"]).toContain(result.status);
  });

  it("offers no text value for raw-text elements", async () => {
    const file = "src/lib/raw.svelte";
    await fs.writeFile(sandbox.file(file), '<iframe title="x">fallback</iframe>\n');
    const node = await selectOne(observation({ file, line: 1, column: 0 }, { tagName: "IFRAME" }));
    expect(node.surfaces.text).toBeNull();
    expect(node.capabilities).toContainEqual({ surface: "text", support: "agent-assisted" });
  });
});

describe("byte order mark", () => {
  it("keeps a second leading U+FEFF as content", async () => {
    const file = "src/lib/double-bom.svelte";
    await fs.writeFile(sandbox.file(file), "\uFEFF\uFEFF<h1>Hello</h1>\n", "utf8");
    // What Svelte's dev runtime reports: one BOM removed, the second is column 0's content.
    const node = await selectOne(observation({ file, line: 1, column: 1 }, { tagName: "H1" }));
    expect(node.surfaces.text).toEqual({ text: "Hello" });
  });

  it("resolves, edits and undoes against BOM-free offsets while the bytes keep the BOM", async () => {
    const file = "src/lib/bom.svelte";
    const original = '\uFEFF<h1 class="title">Hello</h1>\n';
    await fs.writeFile(sandbox.file(file), original, "utf8");
    const originalBytes = await fs.readFile(sandbox.file(file));
    expect([...originalBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const node = await selectOne(observation({ file, line: 1, column: 0 }, { tagName: "H1" }));
    expect(node.definition?.range).toEqual({ start: 0, end: original.length - 2 });
    expect(node.surfaces.text).toEqual({ text: "Hello" });

    const receipt = receiptOf(
      await edit({
        file: `apps/site/${file}`,
        expectedRevision: node.definition!.revision,
        operations: [{ kind: "set_literal_text", range: node.definition!.range, text: "Bye" }],
      })
    );
    const edited = await fs.readFile(sandbox.file(file));
    expect(edited.toString("utf8")).toBe('\uFEFF<h1 class="title">Bye</h1>\n');
    expect(receipt.afterRevision).toBe(sha(edited));

    await test.invoke(CHANNELS.editUndo, {
      workspaceSessionId,
      transactionId: receipt.transactionId,
    });
    expect(Buffer.compare(await fs.readFile(sandbox.file(file)), originalBytes)).toBe(0);
  });
});

describe("undo containment", () => {
  it("refuses when a parent directory has been swapped for a symlink since the edit", async () => {
    const source = await fs.readFile(sandbox.file(NATIVE), "utf8");
    const node = await selectOne(observation(locationOf(source, "<h1"), { tagName: "H1" }));
    const receipt = receiptOf(
      await edit({
        file: NATIVE_IN_WORKTREE,
        expectedRevision: node.definition!.revision,
        operations: [{ kind: "set_literal_text", range: node.definition!.range, text: "Edited" }],
      })
    );
    const edited = await fs.readFile(sandbox.file(NATIVE), "utf8");

    // Same bytes, same spelling, different file on disk.
    await fs.rename(sandbox.file("src/lib"), sandbox.file("src/lib-elsewhere"));
    await fs.symlink(sandbox.file("src/lib-elsewhere"), sandbox.file("src/lib"), "dir");
    const writesBefore = test.writes.length;

    expect(
      await test.invoke(CHANNELS.editUndo, {
        workspaceSessionId,
        transactionId: receipt.transactionId,
      })
    ).toMatchObject({ status: "error", code: "OUT_OF_SCOPE" });
    expect(test.writes).toHaveLength(writesBefore);
    expect(await fs.readFile(sandbox.file("src/lib-elsewhere/native.svelte"), "utf8")).toBe(edited);
  });
});
