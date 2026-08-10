import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRELOAD_CTS = path.resolve(__dirname, "..", "..", "preload.cts");

/**
 * The copyTree preload bindings are a silent-drop seam.
 *
 * They translate positional renderer arguments into the IPC payload object, and
 * nothing else in the suite crosses them: the client tests replace
 * `window.electron.copyTree` with mocks, and the handler tests invoke the main
 * handlers directly, so a parameter that is declared but never placed into the
 * payload is invisible to both. Typecheck does not help either — every one of
 * these parameters is optional, so dropping one from the object literal is
 * legal TypeScript that silently sends `undefined` forever.
 *
 * This channel has no `defineIpcNamespace` codegen backing it (there is no
 * `copyTree.preload.ts`), so a source contract is the only place the invariant
 * can live. It is deliberately general rather than a list of expected keys:
 * "every parameter this binding accepts is forwarded" holds for any future
 * argument too, and pinning today's key names would just restate the source.
 *
 * Read as text rather than imported because `preload.cts` is CommonJS built for
 * the Electron sandbox and pulls in `electron` at module scope.
 */
describe("copyTree preload bindings forward every argument they accept", () => {
  /** `method: (params) => _unwrappingInvoke(CHANNEL, { payload })` */
  const BINDING =
    /(\w+):\s*\(([^)]*)\)\s*=>\s*_unwrappingInvoke\(\s*(CHANNELS\.\w+),\s*\{([^}]*)\}/g;

  const paramNames = (params: string): string[] =>
    params
      .split(",")
      .map((part) => part.split(":")[0]!.trim().replace(/\?$/, ""))
      .filter(Boolean);

  const payloadKeys = (payload: string): string[] =>
    payload
      .split(",")
      .map((part) => part.replace(/\/\/.*$/gm, "").trim())
      .filter(Boolean);

  /**
   * The copyTree namespace only, so an unrelated binding elsewhere in this
   * 1500-line file can neither satisfy nor fail these assertions.
   *
   * Both delimiters are asserted. Without the closing check a missed sentinel
   * yields `indexOf` = -1, and `slice(start, -1)` would quietly widen the scan
   * to the rest of the file instead of failing.
   */
  const copyTreeBlock = (source: string): string => {
    const start = source.indexOf("    copyTree: {");
    expect(start, "copyTree namespace opening not found in preload.cts").toBeGreaterThan(-1);
    const end = source.indexOf("\n    },", start);
    expect(end, "copyTree namespace closing not found in preload.cts").toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("places each declared parameter into the invoke payload", async () => {
    const block = copyTreeBlock(await readFile(PRELOAD_CTS, "utf8"));

    const bindings = [...block.matchAll(BINDING)].map((match) => ({
      method: match[1]!,
      channel: match[3]!,
      params: paramNames(match[2]!),
      payload: payloadKeys(match[4]!),
    }));

    // Guards the scanner itself: a rename or a reformat that stopped matching
    // would otherwise report a vacuous pass over zero bindings.
    expect(bindings.map((binding) => binding.method)).toEqual(
      expect.arrayContaining(["generate", "generateAndCopyFile", "injectToTerminal"])
    );

    for (const { method, channel, params, payload } of bindings) {
      expect(
        params.filter((param) => !payload.includes(param)),
        `${method} (${channel}) accepts these arguments but never forwards them`
      ).toEqual([]);
    }
  });

  it("accepts the run name on all three run-recording bindings", async () => {
    const block = copyTreeBlock(await readFile(PRELOAD_CTS, "utf8"));

    // The check above proves whatever is declared gets forwarded; this proves
    // the run name is declared at all. Without it, deleting the parameter and
    // its payload key together would keep the pair consistent and pass (#11734).
    const named = [...block.matchAll(BINDING)]
      .filter((match) => paramNames(match[2]!).includes("name"))
      .map((match) => match[1]!);

    expect(named.sort()).toEqual(["generate", "generateAndCopyFile", "injectToTerminal"]);
  });
});
