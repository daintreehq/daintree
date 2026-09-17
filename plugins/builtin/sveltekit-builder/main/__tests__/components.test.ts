import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activate } from "../index.js";
import { createSandbox, createTestHost, type Sandbox } from "./testHost.js";
import { CHANNELS } from "../../shared/protocol.js";

let sandbox: Sandbox | null = null;
afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = null;
});

async function open() {
  sandbox = await createSandbox();
  const test = createTestHost(sandbox.worktree);
  await activate(test.host);
  const opened = await test.invoke<{ status: string; workspaceSessionId: string }>(
    CHANNELS.workspaceOpen,
    {
      projectId: "p1",
      worktreeId: "w1",
      worktreePath: sandbox.worktree,
      appRoot: sandbox.appRoot,
      previewPanelId: "preview-1",
    }
  );
  expect(opened.status).toBe("ready");
  const resolve = (callSites: Array<{ file: string; line: number; column: number }>) =>
    test.invoke<{
      definitions: Array<{
        name: string | null;
        definedIn: string | null;
        revision: string | null;
        definedInRevision: string | null;
      }>;
    }>(CHANNELS.componentDefinitions, {
      workspaceSessionId: opened.workspaceSessionId,
      callSites,
    });
  return { resolve, box: sandbox };
}

describe("component definitions from source", () => {
  it("follows the import of the component used at a call site", async () => {
    const { resolve, box } = await open();
    const { definitions } = await resolve([
      { file: "src/lib/invocations.svelte", line: 6, column: 0 },
    ]);
    expect(definitions[0]).toMatchObject({ name: "Card", definedIn: "src/lib/card.svelte" });
    // The revisions are of the very bytes the answer was read from.
    const hash = async (file: string) =>
      createHash("sha256")
        .update(await fs.readFile(path.join(box.appRoot, file)))
        .digest("hex");
    expect(definitions[0]).toMatchObject({
      revision: await hash("src/lib/invocations.svelte"),
      definedInRevision: await hash("src/lib/card.svelte"),
    });
  });

  it("follows $lib imports", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      '<script>\n  import Card from "$lib/card.svelte";\n</script>\n\n<Card plan="x" />\n'
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 5, column: 0 },
    ]);
    expect(definitions[0]).toMatchObject({ name: "Card", definedIn: "src/lib/card.svelte" });
  });

  it("resolves a component used inside a snippet from the file the snippet is written in", async () => {
    const { resolve, box } = await open();
    // The rendered chain puts Badge under Card, but Badge is imported here.
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      '<script>\n  import Card from "$lib/card.svelte";\n  import Badge from "./Badge.svelte";\n</script>\n\n<Card plan="x">\n  {#snippet footer()}\n    <Badge />\n  {/snippet}\n</Card>\n'
    );
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "Badge.svelte"),
      "<span>new</span>\n"
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 8, column: 4 },
    ]);
    expect(definitions[0]).toMatchObject({ name: "Badge", definedIn: "src/routes/Badge.svelte" });
  });

  it("won't name an import that a snippet parameter, each item or prop may shadow", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      [
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
      ].join("\n")
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 7, column: 2 },
      { file: "src/routes/+page.svelte", line: 10, column: 2 },
    ]);
    expect(definitions.map((entry) => entry.definedIn)).toEqual([null, null]);
    expect(definitions.map((entry) => entry.name)).toEqual(["Card", "Card"]);
  });

  it("won't name an import a renamed let: binding or {@const} may shadow", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      [
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
      ].join("\n")
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 7, column: 2 },
      { file: "src/routes/+page.svelte", line: 11, column: 2 },
    ]);
    expect(definitions.map((entry) => entry.definedIn)).toEqual([null, null]);
  });

  it("still resolves when the same name is only bound out of the markup's reach", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      [
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
      ].join("\n")
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 12, column: 0 },
      { file: "src/routes/+page.svelte", line: 14, column: 2 },
    ]);
    expect(definitions.map((entry) => entry.definedIn)).toEqual([
      "src/lib/card.svelte",
      "src/lib/card.svelte",
    ]);
  });

  it("follows slot scope onto the component and the await branch it sits in", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      [
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
      ].join("\n")
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 7, column: 2 },
      { file: "src/routes/+page.svelte", line: 10, column: 2 },
      { file: "src/routes/+page.svelte", line: 12, column: 2 },
    ]);
    expect(definitions.map((entry) => entry.definedIn)).toEqual([
      null,
      "src/lib/card.svelte",
      null,
    ]);
  });

  it("counts a var hoisted out of a block, but not an erased ambient declaration", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      [
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
      ].join("\n")
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 13, column: 0 },
      { file: "src/routes/+page.svelte", line: 14, column: 0 },
    ]);
    expect(definitions.map((entry) => entry.definedIn)).toEqual([null, "src/lib/card.svelte"]);
  });

  it("ignores bindings that can't reach the tag: a dynamic slot's let:, a class static block", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      [
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
      ].join("\n")
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 13, column: 0 },
    ]);
    expect(definitions[0]?.definedIn).toBe("src/lib/card.svelte");
  });

  it("won't prove a component reached through a symlink out of the app", async () => {
    const { resolve, box } = await open();
    const outside = await fs.mkdtemp(path.join(path.dirname(box.appRoot), "outside-"));
    await fs.writeFile(path.join(outside, "Evil.svelte"), "<p>outside</p>\n");
    await fs.symlink(
      path.join(outside, "Evil.svelte"),
      path.join(box.appRoot, "src", "lib", "Evil.svelte")
    );
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      '<script>\n  import Evil from "$lib/Evil.svelte";\n</script>\n\n<Evil />\n'
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 5, column: 0 },
    ]);
    expect(definitions[0]).toMatchObject({ name: "Evil", definedIn: null });
  });

  it("leaves $lib unproven when svelte.config configures kit.files", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "svelte.config.js"),
      'export default { kit: { "files": { lib: "src/ui" } } };\n'
    );
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      '<script>\n  import Card from "$lib/card.svelte";\n</script>\n\n<Card plan="x" />\n'
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 5, column: 0 },
    ]);
    expect(definitions[0]).toMatchObject({ name: "Card", definedIn: null });
  });

  it("proves nothing it can't: no component there, a package import, a missing file", async () => {
    const { resolve, box } = await open();
    await fs.writeFile(
      path.join(box.appRoot, "src", "routes", "+page.svelte"),
      '<script>\n  import Icon from "some-ui/Icon.svelte";\n  import Gone from "./Gone.svelte";\n</script>\n\n<Icon />\n<Gone />\n<p>text</p>\n'
    );
    const { definitions } = await resolve([
      { file: "src/routes/+page.svelte", line: 6, column: 0 },
      { file: "src/routes/+page.svelte", line: 7, column: 0 },
      { file: "src/routes/+page.svelte", line: 8, column: 0 },
      { file: ".svelte-kit/generated/root.svelte", line: 1, column: 0 },
    ]);
    expect(definitions.map((entry) => entry.definedIn)).toEqual([null, null, null, null]);
    expect(definitions.map((entry) => entry.name)).toEqual(["Icon", "Gone", null, null]);
  });
});
