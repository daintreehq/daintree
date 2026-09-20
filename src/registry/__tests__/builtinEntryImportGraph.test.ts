import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { posix, walkEagerGraph } from "../../../scripts/lib/static-import-graph.mjs";

/**
 * `builtinPluginRenderers.ts` eagerly globs every built-in's
 * `renderer/index.ts(x)`, so whatever an entry reaches by *static* import ships
 * to every user, including users who never enable that plugin. This ratchets
 * the half of that graph a plugin owns: its own files.
 *
 * Scoped to plugin-local files on purpose. Host modules (`@/…`, `@shared/…`)
 * are a cut, not an edge, because every entry legitimately imports the registry
 * it registers into, and those reach most of the renderer, zod included via
 * `shared/types/plugin.ts` and `ActionService`. A whole-graph rule flags all
 * four entries on day one, says nothing about the thing worth preventing, and
 * bans the host-owned utilities entries are supposed to use.
 *
 * Consequence of that boundary: a helper shared between two built-ins is only
 * covered through the entry that owns it, so a denied import in a sibling's
 * file escapes unless that sibling's own entry reaches it too.
 *
 * Parsing, resolution and the type-only rules live in
 * `scripts/lib/static-import-graph.mjs`, shared with `markdown-editor`'s
 * stricter local guard so the two cannot disagree about what an eager edge is.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_PLUGINS_DIR = resolve(HERE, "../../../plugins/builtin");

/** Packages a built-in's own eager files must not pull in. */
const DENIED = [/^zod(\/|$)/];

interface BuiltinEntry {
  name: string;
  entry: string;
  root: string;
}

/**
 * Every eagerly globbed entry. Both extensions are returned when a plugin
 * ships both, because the host glob imports both: checking only the first
 * would let a denied import hide in the other.
 */
function builtinEntries(): BuiltinEntry[] {
  return readdirSync(BUILTIN_PLUGINS_DIR, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .flatMap((item) => {
      const root = join(BUILTIN_PLUGINS_DIR, item.name);
      return ["index.ts", "index.tsx"]
        .map((ext) => join(root, "renderer", ext))
        .filter((entry) => existsSync(entry))
        .map((entry) => ({ name: `${item.name}/${relative(root, entry)}`, entry, root }));
    });
}

describe("built-in renderer entries keep heavy packages out of their eager graph", () => {
  const entries = builtinEntries();

  it("finds the built-in renderer entries", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)(
    "$name reaches no denied package from its own eager files",
    ({ entry, root }) => {
      const { bare, unresolved } = walkEagerGraph(entry, root);
      // A relative import that does not resolve is a broken edge, not a pass.
      expect(unresolved).toEqual([]);
      const offenders: string[] = [];
      for (const [file, specifiers] of bare) {
        for (const specifier of specifiers) {
          if (DENIED.some((deny) => deny.test(specifier))) {
            offenders.push(`${posix(relative(BUILTIN_PLUGINS_DIR, file))} imports ${specifier}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    }
  );
});
