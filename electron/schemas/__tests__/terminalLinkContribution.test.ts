import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

const COMMAND = { description: "", category: "Invoices", kind: "command", danger: "safe" };
const COMMANDS = [
  { ...COMMAND, id: "openInvoice", title: "Open invoice" },
  { ...COMMAND, id: "openRecord", title: "Open record" },
];

function parse(
  terminalLinks: unknown,
  { origin = "user", commands = COMMANDS }: { origin?: PluginOrigin; commands?: unknown[] } = {}
) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.invoices",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: { commands, terminalLinks },
  });
}

function issues(result: ReturnType<typeof parse>) {
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
}

const INVOICE = {
  id: "invoice",
  pattern: "\\bINV-(\\d{4,8})\\b",
  actionId: "acme.invoices.openInvoice",
};

const RECORD = {
  id: "record",
  url: { host: "records.example.com", pathPrefix: "/records/" },
  actionId: "acme.invoices.openRecord",
};

describe("contributes.terminalLinks schema (#13798)", () => {
  it("accepts a pattern and a URL matcher, defaulting the scheme and the group", () => {
    const result = parse([INVOICE, RECORD]);
    expect(issues(result)).toEqual([]);
    expect(result.success && result.data.contributes.terminalLinks[1]?.url?.scheme).toBe("https");

    const bare = getPluginManifestSchema("user").safeParse({ name: "acme.t", version: "1.0.0" });
    expect(bare.success && bare.data.contributes.terminalLinks).toEqual([]);
  });

  it("is available to a project plugin", () => {
    expect(issues(parse([INVOICE, RECORD], { origin: "project" }))).toEqual([]);
  });

  it("requires exactly one of pattern or url", () => {
    expect(issues(parse([{ id: "none", actionId: INVOICE.actionId }]))).toEqual([
      {
        path: "contributes.terminalLinks.0.pattern",
        message: expect.stringContaining("exactly one"),
      },
    ]);
    expect(issues(parse([{ ...INVOICE, url: RECORD.url }]))).toEqual([
      { path: "contributes.terminalLinks.0.url", message: expect.stringContaining("exactly one") },
    ]);
  });

  it("refuses ignoreCase on a URL matcher", () => {
    expect(issues(parse([{ ...RECORD, ignoreCase: true }]))[0]?.path).toBe(
      "contributes.terminalLinks.0.ignoreCase"
    );
  });

  it("only dispatches the plugin's own declared commands", () => {
    for (const actionId of ["terminal.new", "other.plugin.open", "acme.invoices."]) {
      expect(issues(parse([{ ...INVOICE, actionId }]))).toEqual([
        {
          path: "contributes.terminalLinks.0.actionId",
          message: expect.stringContaining("own actions"),
        },
      ]);
    }
    expect(issues(parse([{ ...INVOICE, actionId: "acme.invoices.openInvoce" }]))).toEqual([
      {
        path: "contributes.terminalLinks.0.actionId",
        message: expect.stringContaining("matches no entry in contributes.commands"),
      },
    ]);
    // A plugin declaring no commands registers them in code, so any own id passes.
    expect(
      issues(parse([{ ...INVOICE, actionId: "acme.invoices.any" }], { commands: [] }))
    ).toEqual([]);
  });

  it("reports an unsafe pattern on its own field", () => {
    for (const pattern of ["(a+)+b", "(\\w)\\1", "(?<=x)y", "a*", "["]) {
      const found = issues(parse([{ ...INVOICE, pattern }]));
      expect(found).toHaveLength(1);
      expect(found[0]?.path).toBe("contributes.terminalLinks.0.pattern");
    }
  });

  it("refuses hosts plugins may never claim", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "10.0.0.8",
      "printer.local",
      "intranet",
      "Records.example.com",
      "records.example.com:8443",
      "*.example.com",
      "router.lan",
    ]) {
      const found = issues(parse([{ ...RECORD, url: { host } }]));
      expect(found.map((issue) => issue.path)).toEqual(["contributes.terminalLinks.0.url.host"]);
    }
    expect(
      issues(parse([{ ...RECORD, url: { host: "x.example.com", scheme: "file" } }]))
    ).not.toEqual([]);
  });

  it("refuses a malformed path prefix", () => {
    for (const pathPrefix of ["records/", "/records?id=1", "/a/../b", "/has space"]) {
      const found = issues(
        parse([{ ...RECORD, url: { host: "records.example.com", pathPrefix } }])
      );
      expect(found.map((issue) => issue.path)).toEqual([
        "contributes.terminalLinks.0.url.pathPrefix",
      ]);
    }
  });

  it("rejects a duplicate matcher id and more matchers than the cap", () => {
    expect(issues(parse([INVOICE, INVOICE]))[0]?.path).toBe("contributes.terminalLinks.1.id");
    const many = Array.from({ length: 21 }, (_, i) => ({ ...INVOICE, id: `m${i}` }));
    expect(parse(many).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(parse([{ ...INVOICE, flags: "g" }]).success).toBe(false);
    expect(parse([{ ...RECORD, url: { ...RECORD.url, port: 443 } }]).success).toBe(false);
  });
});
