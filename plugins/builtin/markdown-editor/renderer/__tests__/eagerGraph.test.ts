import { describe, expect, it } from "vitest";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { posix, walkEagerGraph } from "../../../../../scripts/lib/static-import-graph.mjs";

/**
 * The builtin renderer glob imports this entry eagerly for every user, so
 * whatever it reaches statically lands in the first-render graph. zod is the
 * expensive passenger: `shared/protocol.ts` pulls it in, which is why the
 * zod-free half of the contract lives in `shared/ids.ts` (#12323). Host `@/…`
 * modules are out of scope: this ratchets the plugin's own files.
 *
 * Stricter than the repo-wide guard in `src/registry/__tests__`, which applies
 * the zod rule to every built-in: this one also pins which of the plugin's own
 * files may be in the graph at all. Both share one walker so they cannot
 * disagree about what counts as an eager edge.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "../..");
const ENTRY = resolve(here, "../index.ts");

const graph = () => walkEagerGraph(ENTRY, pluginRoot);
const reachedFiles = () => graph().files.map((file) => posix(relative(pluginRoot, file)));

describe("eager renderer entry graph", () => {
  it("resolves every relative import it follows", () => {
    expect(graph().unresolved).toEqual([]);
  });

  it("never reaches zod", () => {
    const offenders = [...graph().bare]
      .filter(([, specifiers]) => specifiers.some((specifier) => /^zod(\/|$)/.test(specifier)))
      .map(([file]) => posix(relative(pluginRoot, file)));
    expect(offenders).toEqual([]);
  });

  it("never reaches shared/protocol", () => {
    expect(reachedFiles()).not.toContain("shared/protocol.ts");
  });

  it("walks the files it is meant to walk", () => {
    expect(reachedFiles()).toContain("renderer/recoverDrafts.ts");
    expect(reachedFiles()).toContain("shared/ids.ts");
  });
});
