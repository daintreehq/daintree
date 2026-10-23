import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

const RETIRED = {
  previewTools: [{ id: "daintree.probe.tool", title: "Tool" }],
  guestAdapters: [{ id: "daintree.probe.guest", entry: "renderer/guest/entry.ts" }],
};

function parse(contributes: Record<string, unknown>, origin: PluginOrigin) {
  const name = origin === "builtin" ? "daintree.probe" : "acme.probe";
  return getPluginManifestSchema(origin).safeParse({
    name,
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes,
  });
}

describe("retired previewTools / guestAdapters contribution points (#13891)", () => {
  it.each(["builtin", "user", "project"] as const)("refuses them from a %s plugin", (origin) => {
    for (const [key, value] of Object.entries(RETIRED)) {
      const result = parse({ [key]: value }, origin);
      expect(result.success).toBe(false);
      expect(result.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("leaves both out of the published manifest schema", () => {
    for (const origin of ["builtin", "user", "project"] as const) {
      const emitted = JSON.stringify(
        z.toJSONSchema(getPluginManifestSchema(origin), { io: "input", unrepresentable: "any" })
      );
      expect(emitted).not.toContain('"previewTools"');
      expect(emitted).not.toContain('"guestAdapters"');
    }
  });
});
