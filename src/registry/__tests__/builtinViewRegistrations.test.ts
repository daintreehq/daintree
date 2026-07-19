/**
 * Keeps the two halves of the built-in view seam honest: every
 * `forgeProviders.slots` ref in a built-in plugin's manifest must have a
 * matching `registerBuiltinView` call in that plugin's renderer entry, under the
 * declaring plugin's own id.
 *
 * Nothing else checks this. The main process validates `slots` for shape only —
 * it cannot see the renderer bundle the ids resolve against (see
 * `builtinRendererRegistry.ts` for why that bundle is host-linked rather than
 * `plugin://`-loadable). A typo'd or dropped ref therefore reaches production as
 * silently missing UI, caught only by a dev-mode console warning nobody is
 * watching. The `pluginId` half matters just as much: a registration whose owner
 * doesn't match the manifest slips the enable-aware gate, so disabling the
 * plugin in Preferences leaves its UI on screen.
 *
 * Scope: this is a source scan, not an execution trace. It proves a matching
 * registration *call* is written, not that it runs — a call that is commented
 * out, tree-shaken, or written with a non-literal id is outside what a regex can
 * see. That is a deliberate trade: importing the entries would pull the whole
 * host renderer graph into a dependency-free node test, and the failure this
 * guards (hand-editing one side of the pair) is textual in practice.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_PLUGINS_DIR = path.resolve(HERE, "../../../plugins/builtin");

interface BuiltinPlugin {
  name: string;
  dir: string;
  rendererSource: string;
  slotRefs: string[];
}

interface Registration {
  id: string;
  pluginId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Narrow the parsed manifest by hand rather than asserting a shape onto it: the
 * file is read off disk, so a wrong assumption here would surface as a confusing
 * runtime error inside an assertion instead of a plain "no slot refs found".
 */
function readSlotRefs(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  const contributes = manifest.contributes;
  if (!isRecord(contributes)) return [];
  const providers = contributes.forgeProviders;
  if (!Array.isArray(providers)) return [];

  return providers.flatMap((provider) => {
    if (!isRecord(provider)) return [];
    const slots = provider.slots;
    if (!isRecord(slots)) return [];
    return Object.values(slots).filter(
      (ref): ref is string => typeof ref === "string" && ref !== ""
    );
  });
}

function readManifestName(manifest: unknown, fallback: string): string {
  if (!isRecord(manifest)) return fallback;
  return typeof manifest.name === "string" ? manifest.name : fallback;
}

function readRendererSource(dir: string): string | null {
  for (const entry of ["renderer/index.tsx", "renderer/index.ts"]) {
    const candidate = path.join(dir, entry);
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  }
  return null;
}

/**
 * Every `registerBuiltinView("<id>", Component, { pluginId: "<owner>" })` in the
 * entry. `pluginId` is read from the text between this call's id and the next
 * call, so a multi-line options object is matched but a neighbouring call's
 * owner can't leak into it.
 */
function parseRegistrations(source: string): Registration[] {
  const calls = [...source.matchAll(/registerBuiltinView\(\s*"([^"]+)"/g)];
  return calls.map((call, index) => {
    const id = call[1] ?? "";
    const start = call.index ?? 0;
    const end =
      index + 1 < calls.length ? (calls[index + 1]?.index ?? source.length) : source.length;
    const owner = /pluginId:\s*"([^"]+)"/.exec(source.slice(start, end));
    return { id, pluginId: owner?.[1] ?? null };
  });
}

function loadBuiltinPlugins(): BuiltinPlugin[] {
  if (!fs.existsSync(BUILTIN_PLUGINS_DIR)) return [];
  return fs
    .readdirSync(BUILTIN_PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(BUILTIN_PLUGINS_DIR, entry.name);
      const manifestPath = path.join(dir, "plugin.json");
      const rendererSource = readRendererSource(dir);
      if (!fs.existsSync(manifestPath) || rendererSource === null) return [];

      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return [
        {
          name: readManifestName(manifest, entry.name),
          dir,
          rendererSource,
          slotRefs: readSlotRefs(manifest),
        },
      ];
    });
}

const builtinPlugins = loadBuiltinPlugins();

describe("built-in plugin view registrations", () => {
  it("finds at least one built-in plugin to check", () => {
    // Guards the whole suite against silently passing on an empty discovery —
    // a moved plugins/builtin path would otherwise make every case vacuous.
    expect(builtinPlugins.length).toBeGreaterThan(0);
  });

  describe.each(builtinPlugins.map((plugin) => [plugin.name, plugin] as const))(
    "%s",
    (_name, plugin) => {
      const registrations = parseRegistrations(plugin.rendererSource);
      const registeredIds = registrations.map((registration) => registration.id);

      it("registers a view for every forge provider slot ref", () => {
        const missing = plugin.slotRefs.filter((ref) => !registeredIds.includes(ref));
        expect(missing).toEqual([]);
      });

      it("registers each view under the declaring plugin's own id", () => {
        const referenced = registrations.filter((registration) =>
          plugin.slotRefs.includes(registration.id)
        );
        const misowned = referenced
          .filter((registration) => registration.pluginId !== plugin.name)
          .map((registration) => `${registration.id} -> ${registration.pluginId ?? "(ungated)"}`);
        expect(misowned).toEqual([]);
      });
    }
  );
});
