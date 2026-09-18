/**
 * Keeps the two halves of the guest wire contract honest.
 *
 * Only part of that contract is shared now. The host owns the envelope and the
 * one lifecycle event it acts on; the plugin owns every payload, and the host
 * does not restate them. So this pins exactly what still has to agree — the
 * envelope's field set, the `documentReady` shape, the protocol version, the
 * message ceiling and the declared adapter id — and asserts the rest is
 * genuinely opaque to the host, which is the property that lets a second
 * framework adapter ship without touching `electron/` or `shared/`.
 *
 * It is a source scan, like
 * `src/registry/__tests__/builtinViewRegistrations.test.ts`: importing the
 * plugin module would create exactly the dependency the split exists to avoid.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  guestAdapterAssetPath,
  listBuiltinGuestAdapters,
} from "../sitePreview/guestAdapterAssets.js";
import {
  DOCUMENT_READY,
  GUEST_PROTOCOL_VERSION,
  GuestDocumentReadySchema,
  GuestEnvelopeSchema,
  GuestEventSchema,
  MAX_GUEST_MESSAGE_BYTES,
} from "../sitePreview/guestProtocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PROTOCOL = path.resolve(
  HERE,
  "../../../plugins/builtin/sveltekit-builder/shared/protocol.ts"
);
const BUILTIN_PLUGINS_ROOT = path.resolve(HERE, "../../../plugins/builtin");
const PLUGIN_MANIFEST = path.join(BUILTIN_PLUGINS_ROOT, "sveltekit-builder/plugin.json");

interface BuilderManifest {
  name: string;
  contributes: {
    previewTools: { id: string; guestAdapter?: string }[];
    guestAdapters: { id: string; entry: string }[];
  };
}

function readBuilderManifest(): BuilderManifest {
  return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, "utf8")) as BuilderManifest;
}

function readPluginProtocol(): string {
  return fs.readFileSync(PLUGIN_PROTOCOL, "utf8");
}

/**
 * The page runtime carries its own copy of the ceiling: it is bundled into a
 * standalone asset the host injects, so nothing links it to the host's value. A
 * runtime that believed the ceiling was larger would send envelopes the host
 * drops whole.
 */
const GUEST_RUNTIME = path.resolve(
  HERE,
  "../../../plugins/builtin/sveltekit-builder/renderer/guest/runtime.ts"
);

function readNumericConstant(source: string, name: string): number {
  const match = new RegExp(`(?:export )?const ${name} = ([^;]+);`).exec(source);
  if (!match) throw new Error(`${name} not found in ${PLUGIN_PROTOCOL}`);
  // The plugin writes MAX_GUEST_MESSAGE_BYTES as an expression (`256 * 1024`),
  // so evaluate the arithmetic rather than requiring a literal on either side.
  const expression = match[1]!.replace(/_/g, "").trim();
  if (!/^[\d\s*+]+$/.test(expression)) {
    throw new Error(`${name} is not a plain numeric expression: ${expression}`);
  }
  return Number(
    expression
      .split("*")
      .map((part) => Number(part.trim()))
      .reduce((a, b) => a * b, 1)
  );
}

function pluginGuestEventBlock(source: string): string {
  return source.slice(
    source.indexOf("export const GuestEventSchema"),
    source.indexOf("export const GuestEnvelopeSchema")
  );
}

function pluginGuestEventTypes(source: string): string[] {
  // Discriminants only: payload fields carry literals of their own (a selection's
  // `scope: z.literal("component")`), and those are not event types.
  return [...pluginGuestEventBlock(source).matchAll(/type: z\.literal\("([a-zA-Z]+)"\)/g)].map(
    (m) => m[1]!
  );
}

/** The field names the plugin declares on one member of its event union. */
function pluginEventFields(source: string, type: string): string[] {
  const block = pluginGuestEventBlock(source);
  const literal = block.indexOf(`type: z.literal("${type}")`);
  if (literal === -1) throw new Error(`${type} is not declared in ${PLUGIN_PROTOCOL}`);
  // From the `.object({` that opens the member, so the discriminant itself is
  // counted, to the `.strict()` that closes it.
  const body = block.slice(
    block.lastIndexOf(".object({", literal),
    block.indexOf(".strict()", literal)
  );
  return [...body.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]!).sort();
}

describe("site preview guest protocol", () => {
  it("agrees with the plugin on the protocol version and message ceiling", () => {
    const source = readPluginProtocol();
    expect(readNumericConstant(source, "GUEST_PROTOCOL_VERSION")).toBe(GUEST_PROTOCOL_VERSION);
    expect(readNumericConstant(source, "MAX_GUEST_MESSAGE_BYTES")).toBe(MAX_GUEST_MESSAGE_BYTES);
  });

  it("agrees with the page runtime's own copy of the message ceiling", () => {
    const runtime = fs.readFileSync(GUEST_RUNTIME, "utf8");
    expect(readNumericConstant(runtime, "MAX_MESSAGE_BYTES")).toBe(MAX_GUEST_MESSAGE_BYTES);
  });

  it("agrees with the manifest on the id of the guest runtime it binds to", () => {
    // The plugin sends this id and the host resolves it — through the manifest
    // declaration, which is the only thing that registers an adapter at all — to
    // the asset the build emitted. A rename on one side alone would surface as an
    // unbindable preview, so the manifest is now the other half of this contract.
    const match = /export const GUEST_ADAPTER_ID = "([^"]+)";/.exec(readPluginProtocol());
    const declared = readBuilderManifest().contributes.guestAdapters.map((a) => a.id);
    expect(declared).toContain(match?.[1]);
  });

  it("agrees with the manifest on the id of the preview tool the renderer registers", () => {
    // The renderer entry restates this literal to keep zod out of the eager
    // bundle, and `devPreviewToolRegistry` hides a tool the manifest does not
    // declare — so an undeclared rename here is a builder that never appears.
    const source = readPluginProtocol();
    const pluginId = /export const PLUGIN_ID = "([^"]+)";/.exec(source)?.[1];
    // Composed from PLUGIN_ID in the plugin, so read the suffix out of the
    // template literal rather than expecting a plain string.
    const suffix = /export const BUILDER_TOOL_ID = `\$\{PLUGIN_ID\}\.([a-z0-9-]+)`;/.exec(
      source
    )?.[1];
    expect(pluginId).toBeDefined();
    expect(suffix).toBeDefined();
    const declared = readBuilderManifest().contributes.previewTools.map((t) => t.id);
    expect(declared).toContain(`${pluginId}.${suffix}`);
  });

  it("points each declared preview tool at a guest adapter the same manifest declares", () => {
    const { contributes } = readBuilderManifest();
    const adapterIds = new Set(contributes.guestAdapters.map((a) => a.id));
    for (const tool of contributes.previewTools) {
      if (tool.guestAdapter === undefined) continue;
      expect(adapterIds).toContain(tool.guestAdapter);
    }
  });

  it("derives the guest asset path the build emits from the declared adapter id", () => {
    // The manifest never names the built asset — the host derives it. This pins
    // the derivation for the shipped declaration so a change to it has to be
    // deliberate, and the build's own mirror of the rule is checked against this
    // function in `scripts/__tests__/plugin-build-assets.test.mjs`.
    const declarations = listBuiltinGuestAdapters(BUILTIN_PLUGINS_ROOT);
    const builder = declarations.find((d) => d.pluginId === "daintree.sveltekit-builder");
    expect(builder).toBeDefined();
    expect(builder?.entry).toBe("renderer/guest/entry.ts");
    expect(builder?.assetPath).toBe("guest/guest.js");
    expect(guestAdapterAssetPath("daintree.sveltekit-builder", builder!.adapterId)).toBe(
      "guest/guest.js"
    );
  });

  it("agrees with the plugin on the shape of the lifecycle event", () => {
    // The host acts on this one — a well-formed `documentReady` is what marks a
    // binding ready — so both sides have to declare it the same way. Extra
    // fields are the adapter's business; the named ones are not.
    const fields = pluginEventFields(readPluginProtocol(), DOCUMENT_READY);
    expect(fields).toEqual(Object.keys(GuestDocumentReadySchema.shape).sort());
  });

  it("rejects a lifecycle event that does not match that shape", () => {
    // Without this, a malformed `documentReady` would fall through to the
    // opaque branch and still set readiness.
    expect(GuestEventSchema.safeParse({ type: DOCUMENT_READY }).success).toBe(false);
    expect(
      GuestEventSchema.safeParse({
        type: DOCUMENT_READY,
        routeId: null,
        url: "http://localhost:5173/",
        viewport: { width: 0, height: 100, deviceScaleFactor: 1 },
      }).success
    ).toBe(false);
    // Strict, alone among the events, because the adapter's own declaration of
    // this one is strict too: a readiness event the host admits and the adapter
    // drops is a binding called ready for a document the panel never got.
    expect(
      GuestEventSchema.safeParse({
        type: DOCUMENT_READY,
        routeId: null,
        url: "http://localhost:5173/",
        viewport: { width: 100, height: 100, deviceScaleFactor: 1 },
        extra: true,
      }).success
    ).toBe(false);
  });

  it("leaves every other event the plugin declares opaque to the host", () => {
    // The inverse of the old mirror test: the host must *not* know these
    // payloads. A `type` and a well-formed envelope is all it asks for, so the
    // next framework adapter needs no member in `electron/` or `shared/`.
    const declared = pluginGuestEventTypes(readPluginProtocol());
    expect(declared).toContain(DOCUMENT_READY);
    for (const type of declared) {
      if (type === DOCUMENT_READY) continue;
      expect(GuestEventSchema.safeParse({ type }).success).toBe(true);
    }
    expect(GuestEventSchema.safeParse({ type: "aria-tree-changed", tree: [] }).success).toBe(true);
    // A `type` is still mandatory, and bounded.
    expect(GuestEventSchema.safeParse({ tree: [] }).success).toBe(false);
    expect(GuestEventSchema.safeParse({ type: "" }).success).toBe(false);
    expect(GuestEventSchema.safeParse({ type: "x".repeat(65) }).success).toBe(false);
  });

  it("agrees with the plugin on the envelope's field set", () => {
    const source = readPluginProtocol();
    const block = source.slice(
      source.indexOf("export const GuestEnvelopeSchema"),
      source.indexOf("export type GuestEnvelope")
    );
    const pluginFields = [...block.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!).sort();
    expect(pluginFields.length).toBeGreaterThan(0);
    expect(pluginFields).toEqual(Object.keys(GuestEnvelopeSchema.shape).sort());
  });
});
