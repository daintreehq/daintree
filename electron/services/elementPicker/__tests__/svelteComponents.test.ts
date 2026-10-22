import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolutionResult } from "../../../../shared/elementPicker/resolution.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import {
  component,
  createSandbox,
  evidence,
  fileHint,
  invocation,
  rangeOf,
  ref,
  resolveIn,
  revisionOfFile,
  selection,
  type CallSite,
  type Sandbox,
} from "./svelteTestContext.js";

const PAGE = "src/routes/+page.svelte";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

/** Each call site as its own component record, the way a chain lists them. */
async function invoke(sites: CallSite[]): Promise<ResolutionResult[]> {
  const { results } = await resolveIn(sandbox, [
    selection({ components: sites.map((site) => component([invocation(site)])) }),
  ]);
  return results;
}

/**
 * The app-relative file each call site's import was proven to bind, or null.
 * Every call site here is real, so each must verify: a definition is absent
 * because the binding is unproven, never because the call site failed.
 */
async function definitions(sites: CallSite[]): Promise<Array<string | null>> {
  const results = await invoke(sites);
  expect(results.map((result) => result.state)).toEqual(sites.map(() => "verified"));
  return results.map((result) =>
    result.state === "verified" && result.definition
      ? result.definition.file.path.slice(`${ref("").path}`.length)
      : null
  );
}

async function page(lines: string[]): Promise<void> {
  await sandbox.write(PAGE, lines.join("\n"));
}

describe("component definitions from source", () => {
  it("follows the import of the component used at a call site", async () => {
    const file = "src/lib/invocations.svelte";
    const source = await fs.readFile(sandbox.file(file), "utf8");
    const [result] = await invoke([{ file, line: 6, column: 0 }]);
    // The revisions are of the very bytes the answer was read from.
    expect(result).toMatchObject({
      state: "verified",
      claim: "component-invocation",
      target: { file: ref(file), location: rangeOf(source, '<Card plan="Basic"', "/>") },
      fileRevision: await revisionOfFile(sandbox.file(file)),
      definition: {
        file: ref("src/lib/card.svelte"),
        fileRevision: await revisionOfFile(sandbox.file("src/lib/card.svelte")),
        specifier: "./card.svelte",
      },
    });
  });

  it("follows $lib imports in a SvelteKit app", async () => {
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      "</script>",
      "",
      '<Card plan="x" />',
      "",
    ]);
    expect(await definitions([{ file: PAGE, line: 5, column: 0 }])).toEqual([
      "src/lib/card.svelte",
    ]);
  });

  it("follows relative imports in a plain Svelte app, and never guesses its $lib", async () => {
    await sandbox.cleanup();
    sandbox = await createSandbox({ kit: false });
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      '  import Native from "../lib/native.svelte";',
      "</script>",
      "",
      '<Card plan="x" />',
      "<Native />",
      "",
    ]);
    expect(
      await definitions([
        { file: PAGE, line: 6, column: 0 },
        { file: PAGE, line: 7, column: 0 },
      ])
    ).toEqual([null, "src/lib/native.svelte"]);
  });

  it("resolves a component used inside a snippet from the file the snippet is written in", async () => {
    // The rendered chain puts Badge under Card, but Badge is imported here.
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      '  import Badge from "./Badge.svelte";',
      "</script>",
      "",
      '<Card plan="x">',
      "  {#snippet footer()}",
      "    <Badge />",
      "  {/snippet}",
      "</Card>",
      "",
    ]);
    await sandbox.write("src/routes/Badge.svelte", "<span>new</span>\n");
    expect(await definitions([{ file: PAGE, line: 8, column: 4 }])).toEqual([
      "src/routes/Badge.svelte",
    ]);
  });

  it("won't name an import that a snippet parameter or each item may shadow", async () => {
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      "  let { items } = $props();",
      "</script>",
      "",
      "{#snippet item(Card)}",
      "  <Card />",
      "{/snippet}",
      "{#each items as Card}",
      "  <Card />",
      "{/each}",
      "",
    ]);
    const results = await invoke([
      { file: PAGE, line: 7, column: 2 },
      { file: PAGE, line: 10, column: 2 },
    ]);
    // Both call sites are real; neither binding is proven.
    expect(results.map((result) => result.state)).toEqual(["verified", "verified"]);
    expect(results.map((result) => result.state === "verified" && result.definition)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("won't name an import a renamed let: binding or {@const} may shadow", async () => {
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      '  import Provider from "$lib/card.svelte";',
      "</script>",
      "",
      "<Provider let:item={Card}>",
      "  <Card />",
      "</Provider>",
      "{#if true}",
      "  {@const Card = Provider}",
      "  <Card />",
      "{/if}",
      "",
    ]);
    expect(
      await definitions([
        { file: PAGE, line: 7, column: 2 },
        { file: PAGE, line: 11, column: 2 },
      ])
    ).toEqual([null, null]);
  });

  it("still resolves when the same name is only bound out of the markup's reach", async () => {
    await page([
      '<script module lang="ts">',
      '  import type Card from "$lib/card.svelte";',
      "</script>",
      '<script lang="ts">',
      '  import Card from "$lib/card.svelte";',
      "  function helper(Card: unknown) {",
      "    const inner = Card;",
      "    return inner;",
      "  }",
      "</script>",
      "",
      '<Card plan="x" />',
      "{#each [1] as item}",
      "  <Card plan={String(item)} />",
      "{/each}",
      "",
    ]);
    expect(
      await definitions([
        { file: PAGE, line: 12, column: 0 },
        { file: PAGE, line: 14, column: 2 },
      ])
    ).toEqual(["src/lib/card.svelte", "src/lib/card.svelte"]);
  });

  it("follows slot scope onto the component and the await branch it sits in", async () => {
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      "  let { promise } = $props();",
      "</script>",
      "",
      "<Card>",
      '  <Card slot="footer" let:item={Card} />',
      "</Card>",
      "{#await promise}",
      "  <Card />",
      "{:then Card}",
      "  <Card />",
      "{/await}",
      "",
    ]);
    expect(
      await definitions([
        { file: PAGE, line: 7, column: 2 },
        { file: PAGE, line: 10, column: 2 },
        { file: PAGE, line: 12, column: 2 },
      ])
    ).toEqual([null, "src/lib/card.svelte", null]);
  });

  it("counts a var hoisted out of a block, but not an erased ambient declaration", async () => {
    await page([
      '<script module lang="ts">',
      '  import Card from "$lib/card.svelte";',
      "  declare const Badge: unknown;",
      "</script>",
      '<script lang="ts">',
      '  import Badge from "$lib/card.svelte";',
      "  let { flag } = $props();",
      "  if (flag) {",
      "    var Card = Badge;",
      "  }",
      "</script>",
      "",
      "<Card />",
      "<Badge />",
      "",
    ]);
    expect(
      await definitions([
        { file: PAGE, line: 13, column: 0 },
        { file: PAGE, line: 14, column: 0 },
      ])
    ).toEqual([null, "src/lib/card.svelte"]);
  });

  it("ignores bindings that can't reach the tag: a dynamic slot's let:, a class static block", async () => {
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      "  let { flag, slotName } = $props();",
      "  if (flag) {",
      "    class Local {",
      "      static {",
      "        var Card;",
      "      }",
      "    }",
      "  }",
      "</script>",
      "",
      "<Card slot={slotName} let:item={Card} />",
      "",
    ]);
    expect(await definitions([{ file: PAGE, line: 13, column: 0 }])).toEqual([
      "src/lib/card.svelte",
    ]);
  });

  it("won't prove a component reached through a symlink out of the app", async () => {
    const outside = await fs.mkdtemp(path.join(path.dirname(sandbox.appRoot), "outside-"));
    await fs.writeFile(path.join(outside, "Evil.svelte"), "<p>outside</p>\n");
    await fs.symlink(path.join(outside, "Evil.svelte"), sandbox.file("src/lib/Evil.svelte"));
    await page([
      "<script>",
      '  import Evil from "$lib/Evil.svelte";',
      "</script>",
      "",
      "<Evil />",
      "",
    ]);
    expect(await definitions([{ file: PAGE, line: 5, column: 0 }])).toEqual([null]);
  });

  it("leaves $lib unproven when svelte.config configures kit.files", async () => {
    await sandbox.write(
      "svelte.config.js",
      'export default { kit: { "files": { lib: "src/ui" } } };\n'
    );
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      "</script>",
      "",
      '<Card plan="x" />',
      "",
    ]);
    expect(await definitions([{ file: PAGE, line: 5, column: 0 }])).toEqual([null]);
  });

  it("leaves $lib unproven when svelte.config takes its settings from a module of the app's own", async () => {
    await sandbox.write(
      "svelte.config.base.js",
      'export default { kit: { "files": { lib: "src/ui" } } };\n'
    );
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      "</script>",
      "",
      '<Card plan="x" />',
      "",
    ]);
    for (const config of [
      'import base from "./svelte.config.base.js";\nexport default base;\n',
      "const base = require('./svelte.config.base.js');\nmodule.exports = { ...base };\n",
      "export default (await import(`./svelte.config.base.js`)).default;\n",
    ]) {
      await sandbox.write("svelte.config.js", config);
      expect(await definitions([{ file: PAGE, line: 5, column: 0 }])).toEqual([null]);
    }
    // A package import is how every config gets its adapter, and proves nothing either way.
    await sandbox.write(
      "svelte.config.js",
      'import adapter from "@sveltejs/adapter-auto";\nexport default { kit: { adapter: adapter() } };\n'
    );
    expect(await definitions([{ file: PAGE, line: 5, column: 0 }])).toEqual([
      "src/lib/card.svelte",
    ]);
  });

  it("leaves $lib unproven when a config it would have to read is past the byte limit", async () => {
    await sandbox.write("svelte.config.js", `export default {};\n// ${"x".repeat(200)}\n`);
    await page([
      "<script>",
      '  import Card from "$lib/card.svelte";',
      "</script>",
      "",
      '<Card plan="x" />',
      "",
    ]);
    const { results } = await resolveIn(
      sandbox,
      [selection({ components: [component([invocation({ file: PAGE, line: 5, column: 0 })])] })],
      { budget: { maxFileBytes: 128 } }
    );
    expect(results[0]).toMatchObject({ state: "verified" });
    expect(results[0]).not.toHaveProperty("definition");
  });

  it("proves nothing it can't: a package import, a missing file, no component there, a generated file", async () => {
    await page([
      "<script>",
      '  import Icon from "some-ui/Icon.svelte";',
      '  import Gone from "./Gone.svelte";',
      "</script>",
      "",
      "<Icon />",
      "<Gone />",
      "<p>text</p>",
      "",
    ]);
    const results = await invoke([
      { file: PAGE, line: 6, column: 0 },
      { file: PAGE, line: 7, column: 0 },
      { file: PAGE, line: 8, column: 0 },
      { file: ".svelte-kit/generated/root.svelte", line: 1, column: 0 },
    ]);
    expect(
      results.map((result) =>
        result.state === "verified"
          ? (result.definition?.file.path ?? "no definition")
          : result.state === "unavailable" && result.reason
      )
    ).toEqual(["no definition", "no definition", "mismatch", "unsupported"]);
  });

  it("holds the call site to the tag the page recorded it was written as", async () => {
    const file = "src/lib/invocations.svelte";
    const frame = (componentTag: string) => ({
      type: "component",
      file,
      line: 6,
      column: 0,
      componentTag,
    });
    const resolve = async (componentTag: string) =>
      (
        await resolveIn(sandbox, [
          selection({
            components: [component([invocation({ file, line: 6, column: 0 })])],
            evidence: evidence({ ancestry: [frame(componentTag)] }),
          }),
        ])
      ).results[0];
    expect(await resolve("Card")).toMatchObject({ state: "verified" });
    // The page rendered some other component from this spot: the file moved on.
    expect(await resolve("Pricing")).toMatchObject({
      state: "unavailable",
      reason: "mismatch",
      read: { file: ref(file) },
    });
  });
});

describe("a component's reported definition", () => {
  const file = "src/lib/invocations.svelte";
  const site = { file, line: 6, column: 0 };

  it("is verified as a file, and nothing finer, when the call site's import proves it", async () => {
    const hint = fileHint("src/lib/card.svelte");
    const { results } = await resolveIn(sandbox, [
      selection({ components: [component([invocation(site), hint])] }),
    ]);
    expect(results[1]).toEqual({
      state: "verified",
      candidateId: hint.candidateId,
      claim: "file-hint",
      target: { file: ref("src/lib/card.svelte"), location: null },
      fileRevision: await revisionOfFile(sandbox.file("src/lib/card.svelte")),
    });
  });

  it("is a mismatch read in the call site's file when its import binds another", async () => {
    // A wrapper with no element of its own shares its roots with the
    // component inside it, so the roots name the inner one's file.
    const { results } = await resolveIn(sandbox, [
      selection({ components: [component([invocation(site), fileHint("src/lib/native.svelte")])] }),
    ]);
    expect(results[1]).toMatchObject({
      state: "unavailable",
      reason: "mismatch",
      read: { file: ref(file), fileRevision: await revisionOfFile(sandbox.file(file)) },
    });
  });

  it("stays as reported, read but unchecked, when nothing proves it either way", async () => {
    const { results } = await resolveIn(sandbox, [
      selection({ components: [component([fileHint("src/lib/card.svelte")])] }),
    ]);
    expect(results[0]).toMatchObject({
      state: "observed",
      target: { file: ref("src/lib/card.svelte"), location: null },
      fileRevision: await revisionOfFile(sandbox.file("src/lib/card.svelte")),
    });
  });

  it("is never left as observed when the proof was stopped rather than refused", async () => {
    // The element's own hint reads native.svelte first, so the record's hint
    // has bytes in hand. Two files of budget: that one and the call site's.
    // Following the import to card.svelte is refused for budget, which says
    // nothing about where the component is written.
    const { results } = await resolveIn(
      sandbox,
      [
        selection({
          sourceCandidates: [fileHint("src/lib/native.svelte")],
          components: [component([invocation(site), fileHint("src/lib/native.svelte")])],
        }),
      ],
      { budget: { maxFiles: 2 } }
    );
    expect(results[0]).toMatchObject({ state: "observed" });
    expect(results[1]).toMatchObject({ state: "verified" });
    expect(results[1]).not.toHaveProperty("definition");
    expect(results[2]).toMatchObject({ state: "unavailable", reason: "budget-exhausted" });
  });

  it("answers a positioned definition claim with the file alone", async () => {
    const definition: SourceCandidate = {
      kind: "component-definition",
      candidateId: "definition-1",
      framework: "svelte",
      extraction: { kind: "runtime-field", field: "__svelte_meta.loc" },
      file: "src/lib/card.svelte",
      location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 5, column: 0 },
    };
    const { results } = await resolveIn(sandbox, [
      selection({ components: [component([invocation(site), definition])] }),
    ]);
    expect(results[1]).toEqual({
      state: "verified",
      candidateId: definition.candidateId,
      claim: "component-definition",
      target: { file: ref("src/lib/card.svelte"), location: null },
      fileRevision: await revisionOfFile(sandbox.file("src/lib/card.svelte")),
    });
  });

  it("is held to the record's first call site, the one that rendered this copy", async () => {
    await page([
      "<script>",
      '  import Native from "../lib/native.svelte";',
      "</script>",
      "",
      "<Native />",
      "",
    ]);
    const { results } = await resolveIn(sandbox, [
      selection({
        components: [
          component([
            invocation(site),
            invocation({ file: PAGE, line: 5, column: 0 }),
            fileHint("src/lib/card.svelte"),
          ]),
        ],
      }),
    ]);
    expect(results.map((result) => result.state === "verified" && result.definition?.file)).toEqual(
      [ref("src/lib/card.svelte"), ref("src/lib/native.svelte"), undefined]
    );
    expect(results[2]).toMatchObject({
      state: "verified",
      target: { file: ref("src/lib/card.svelte") },
    });
  });

  it("goes stale with the call site it was proven from", async () => {
    const known = await revisionOfFile(sandbox.file(file));
    const source = await fs.readFile(sandbox.file(file), "utf8");
    await sandbox.write(file, `${source}\n<!-- agent -->\n`);
    const { results } = await resolveIn(
      sandbox,
      [selection({ components: [component([invocation(site), fileHint("src/lib/card.svelte")])] })],
      { knownRevisions: [{ file: ref(file), revision: known }] }
    );
    expect(results.map((result) => result.state === "stale" && result.reason)).toEqual([
      "file-changed",
      "file-changed",
    ]);
    expect(results[1]).toMatchObject({
      held: { target: { file: ref("src/lib/card.svelte"), location: null } },
    });
  });
});
