/**
 * Keeps the two halves of the guest wire contract honest.
 *
 * The plugin owns the canonical declaration, but `electron/` may not import
 * from `plugins/` — so the host restates the shape in
 * `electron/services/sitePreview/guestProtocol.ts` and this test is the only
 * thing that notices when one side moves. It is a source scan, like
 * `src/registry/__tests__/builtinViewRegistrations.test.ts`: importing the
 * plugin module would create exactly the dependency the split exists to avoid.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  GUEST_PROTOCOL_VERSION,
  GuestEnvelopeSchema,
  GuestEventSchema,
  MAX_GUEST_MESSAGE_BYTES,
} from "../sitePreview/guestProtocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PROTOCOL = path.resolve(
  HERE,
  "../../../plugins/builtin/sveltekit-builder/shared/protocol.ts"
);

function readPluginProtocol(): string {
  return fs.readFileSync(PLUGIN_PROTOCOL, "utf8");
}

function readNumericConstant(source: string, name: string): number {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(source);
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

function guestEventTypes(source: string): string[] {
  const guestEventBlock = source.slice(
    source.indexOf("export const GuestEventSchema"),
    source.indexOf("export const GuestEnvelopeSchema")
  );
  return [...guestEventBlock.matchAll(/z\.literal\("([a-zA-Z]+)"\)/g)].map((m) => m[1]!);
}

describe("site preview guest protocol", () => {
  it("agrees with the plugin on the protocol version and message ceiling", () => {
    const source = readPluginProtocol();
    expect(readNumericConstant(source, "GUEST_PROTOCOL_VERSION")).toBe(GUEST_PROTOCOL_VERSION);
    expect(readNumericConstant(source, "MAX_GUEST_MESSAGE_BYTES")).toBe(MAX_GUEST_MESSAGE_BYTES);
  });

  it("agrees with the plugin on the set of guest event types", () => {
    const hostTypes = GuestEventSchema.options.map((option) => option.shape.type.value).sort();
    expect(hostTypes.length).toBeGreaterThan(0);
    expect(guestEventTypes(readPluginProtocol()).sort()).toEqual(hostTypes);
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
