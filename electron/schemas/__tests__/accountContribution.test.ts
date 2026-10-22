import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";

const OAUTH = {
  kind: "oauth2",
  label: "Tracker",
  authorizeUrl: "https://auth.example.com/oauth/authorize",
  tokenUrl: "https://auth.example.com/oauth/token",
  clientId: "daintree",
};

function parse(account: unknown, capabilities: string[] = ["network:fetch"]) {
  return getPluginManifestSchema("user").safeParse({
    name: "acme.tracker",
    version: "1.0.0",
    capabilities,
    contributes: { account },
  });
}

function errorCodes(result: ReturnType<typeof parse>): string[] {
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? issue.code
  );
}

describe("contributes.account", () => {
  it("accepts an OAuth account and defaults its scopes to none", () => {
    const result = parse(OAUTH);
    expect(result.success && result.data.contributes.account).toEqual({ ...OAUTH, scopes: [] });
  });

  it("accepts a pasted-token account with an identity lookup", () => {
    const result = parse({
      kind: "token",
      label: "Tracker",
      identity: { url: "https://api.example.com/me", field: "user.login" },
    });
    expect(result.success).toBe(true);
  });

  it("requires the network:fetch capability", () => {
    expect(errorCodes(parse(OAUTH, []))).toContain("account_requires_network_fetch");
  });

  it.each([
    ["an http token URL", { tokenUrl: "http://auth.example.com/token" }, "scope_url_not_https"],
    [
      "a loopback authorize URL",
      { authorizeUrl: "https://127.0.0.1/authorize" },
      "scope_url_private_target",
    ],
    [
      "credentials in the token URL",
      { tokenUrl: "https://u:p@auth.example.com/token" },
      "scope_url_has_credentials",
    ],
    ["a fragment", { authorizeUrl: "https://auth.example.com/a#x" }, "account_url_fragment"],
  ])("refuses %s", (_name, override, code) => {
    expect(errorCodes(parse({ ...OAUTH, ...override }))).toContain(code);
  });

  it("refuses a client secret, since the host is a public client", () => {
    expect(parse({ ...OAUTH, clientSecret: "s3cret" }).success).toBe(false);
  });

  it("refuses a scope with a space in it", () => {
    expect(parse({ ...OAUTH, scopes: ["read write"] }).success).toBe(false);
  });

  it("refuses an identity field that isn't a plain dotted path", () => {
    const identity = { url: "https://api.example.com/me", field: "user[0]" };
    expect(parse({ kind: "token", label: "Tracker", identity }).success).toBe(false);
  });
});
