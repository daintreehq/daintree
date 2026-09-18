import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

const BUILDER = "daintree.sveltekit-builder";

function parse(contributes: Record<string, unknown>, origin: PluginOrigin = "builtin") {
  return getPluginManifestSchema(origin).safeParse({
    name: origin === "builtin" ? BUILDER : "acme.preview",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes,
  });
}

function errorCodes(result: ReturnType<typeof parse>): string[] {
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? issue.code
  );
}

const tool = { id: `${BUILDER}.builder`, title: "Site Builder", guestAdapter: `${BUILDER}.guest` };
const adapter = { id: `${BUILDER}.guest`, entry: "renderer/guest/entry.ts" };

describe("contributes.previewTools / contributes.guestAdapters", () => {
  it("accepts a built-in manifest declaring a tool bound to its own adapter", () => {
    const result = parse({
      previewTools: [{ ...tool, iconId: "square-dashed-mouse-pointer" }],
      guestAdapters: [adapter],
    });
    expect(result.success).toBe(true);
  });

  it("materializes both as empty arrays when the manifest declares neither", () => {
    const result = parse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.previewTools).toEqual([]);
    expect(result.data.contributes.guestAdapters).toEqual([]);
  });

  it("refuses an installed plugin declaring either", () => {
    expect(
      errorCodes(parse({ previewTools: [{ id: "acme.preview.tool", title: "T" }] }, "user"))
    ).toContain("previewTools_builtin_only");
    expect(
      errorCodes(parse({ guestAdapters: [{ id: "acme.preview.guest", entry: "g.ts" }] }, "user"))
    ).toContain("guestAdapters_builtin_only");
  });

  it("refuses a project plugin declaring either", () => {
    expect(
      errorCodes(parse({ previewTools: [{ id: "acme.preview.tool", title: "T" }] }, "project"))
    ).toContain("previewTools_builtin_only");
    expect(
      errorCodes(parse({ guestAdapters: [{ id: "acme.preview.guest", entry: "g.ts" }] }, "project"))
    ).toContain("guestAdapters_builtin_only");
  });

  it("refuses an id equal to the plugin name, which leaves no segment to name an asset", () => {
    // It would pass a bare prefix check and then be skipped silently by the
    // asset derivation, so the manifest is where it has to fail.
    expect(errorCodes(parse({ previewTools: [{ id: BUILDER, title: "T" }] }))).toContain(
      "previewTools_id_not_namespaced"
    );
    expect(
      errorCodes(parse({ guestAdapters: [{ id: BUILDER, entry: "renderer/g.ts" }] }))
    ).toContain("guestAdapters_id_not_namespaced");
  });

  it("refuses a multi-segment suffix, which two ids could derive one asset from", () => {
    // `<plugin>.a.b` and `<plugin>.a-b` would compete for `guest/a-b.js`.
    expect(
      errorCodes(parse({ guestAdapters: [{ id: `${BUILDER}.a.b`, entry: "renderer/g.ts" }] }))
    ).toContain("guestAdapters_id_not_namespaced");
    expect(
      parse({ guestAdapters: [{ id: `${BUILDER}.a-b`, entry: "renderer/g.ts" }] }).success
    ).toBe(true);
  });

  it("refuses an id namespaced under a plugin whose name is merely a prefix", () => {
    // `daintree.sveltekit-builder` vs a hypothetical `daintree.sveltekit`: the
    // prefix test must not let one claim the other's ids.
    expect(
      errorCodes(parse({ previewTools: [{ id: "daintree.sveltekit.builder", title: "T" }] }))
    ).toContain("previewTools_id_not_namespaced");
  });

  it("refuses an id that is not namespaced under the declaring plugin", () => {
    expect(
      errorCodes(parse({ previewTools: [{ id: "other.plugin.builder", title: "T" }] }))
    ).toContain("previewTools_id_not_namespaced");
    expect(
      errorCodes(parse({ guestAdapters: [{ id: "other.plugin.guest", entry: "renderer/g.ts" }] }))
    ).toContain("guestAdapters_id_not_namespaced");
  });

  it("refuses a tool pointing at a guest adapter no manifest entry declares", () => {
    expect(errorCodes(parse({ previewTools: [tool], guestAdapters: [] }))).toContain(
      "preview_tool_guest_adapter_undeclared"
    );
  });

  it("refuses an entry path that escapes the plugin directory", () => {
    for (const entry of [
      "../sibling/guest/entry.ts",
      "renderer/../../evil.ts",
      "/etc/passwd.ts",
      "renderer\\guest\\entry.ts",
      "renderer/guest/entry.json",
    ]) {
      const result = parse({ guestAdapters: [{ id: `${BUILDER}.guest`, entry }] });
      expect(result.success, entry).toBe(false);
    }
  });

  it("rejects a duplicate id within either array", () => {
    // A second entry under one id would declare one admission twice, or two
    // sources for one derived asset.
    expect(
      errorCodes(
        parse({
          previewTools: [
            { id: `${BUILDER}.builder`, title: "One" },
            { id: `${BUILDER}.builder`, title: "Two" },
          ],
        })
      )
    ).toContain("duplicate_contribution_id");
    expect(
      errorCodes(
        parse({
          guestAdapters: [
            { id: `${BUILDER}.guest`, entry: "renderer/a.ts" },
            { id: `${BUILDER}.guest`, entry: "renderer/b.ts" },
          ],
        })
      )
    ).toContain("duplicate_contribution_id");
  });

  it("rejects an unknown field on either entry", () => {
    expect(parse({ previewTools: [{ ...tool, rendererEntry: "x.js" }] }).success).toBe(false);
    expect(parse({ guestAdapters: [{ ...adapter, protocol: "svelte/1" }] }).success).toBe(false);
  });

  it("requires a title on a preview tool", () => {
    expect(parse({ previewTools: [{ id: `${BUILDER}.builder` }] }).success).toBe(false);
    expect(parse({ previewTools: [{ id: `${BUILDER}.builder`, title: "  " }] }).success).toBe(
      false
    );
  });
});
