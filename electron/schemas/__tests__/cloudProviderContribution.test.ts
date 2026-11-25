import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "ec2",
    name: "EC2",
    description: "Machines on your own AWS account.",
    apiUrl: "https://ec2.amazonaws.com",
    apiKeyUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    dashboardUrl: "https://console.aws.amazon.com/ec2/home",
    docsUrl: "https://docs.aws.amazon.com/ec2/",
    credentialFields: [
      {
        id: "accessKeyId",
        label: "Access key ID",
        secret: false,
        input: "single-line",
        required: true,
      },
      {
        id: "secretAccessKey",
        label: "Secret access key",
        secret: true,
        input: "single-line",
        required: true,
      },
    ],
    capabilities: {
      persistence: {
        kept: "Its EBS volume",
        lost: "Instance store and memory",
        retentionDays: null,
        saveRetryBilled: false,
        stoppedComputeBilled: false,
      },
      typicalStartSeconds: 45,
      lifetime: { kind: "none" },
      sshTrust: "provider-tunnel",
      transport: "provider-command",
      tunnel: {
        command: "aws",
        args: ["ssm", "start-session", "--target", "%h"],
        installUrl: "https://aws.amazon.com/cli/",
      },
      provisioning: {
        location: "required",
        image: "optional",
        network: "none",
        sshKey: "after-create",
      },
      deletion: true,
    },
    ...overrides,
  };
}

function parse(cloudProviders: unknown[], origin: PluginOrigin = "user", extra = {}) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.clouds",
    version: "1.0.0",
    ...extra,
    contributes: { cloudProviders },
  });
}

function messages(result: ReturnType<typeof parse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("contributes.cloudProviders", () => {
  it("accepts a provider with its credentials, capabilities and a tunnel, and fills an omitted hint", () => {
    const result = parse([provider()]);
    expect(messages(result)).toEqual([]);
    expect(
      result.success && result.data.contributes.cloudProviders[0]!.credentialFields[0]
    ).toEqual(expect.objectContaining({ id: "accessKeyId", help: null }));
  });

  it("is empty when a manifest declares none", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.clouds",
      version: "1.0.0",
    });
    expect(result.success && result.data.contributes.cloudProviders).toEqual([]);
  });

  it("refuses one from a repository's plugin", () => {
    const result = parse([provider()], "project", { scope: "project" });
    expect(result.success).toBe(false);
    const issue = !result.success
      ? result.error.issues.find((i) => i.path.join(".") === "contributes.cloudProviders")
      : undefined;
    expect((issue as { params?: { errorCode?: string } } | undefined)?.params?.errorCode).toBe(
      "cloudProviders_project_scope_forbidden"
    );
  });

  it("refuses one from an installed package that runs one instance per project", () => {
    const result = parse([provider()], "user", { instanceMode: "project" });
    expect(result.success).toBe(false);
    expect(
      !result.success &&
        result.error.issues.some((i) => i.path.join(".") === "contributes.cloudProviders")
    ).toBe(true);
  });

  it("refuses an id that couldn't be a provider's name, and the same id twice", () => {
    expect(parse([provider({ id: "EC2" })]).success).toBe(false);
    expect(parse([provider({ id: "a.b" })]).success).toBe(false);
    expect(parse([provider({ id: "x".repeat(33) })]).success).toBe(false);
    expect(messages(parse([provider(), provider()]))).toContainEqual(
      expect.stringContaining('Duplicate id "ec2"')
    );
  });

  it("takes an https origin as its API, nothing more", () => {
    expect(parse([provider({ apiUrl: "https://ec2.amazonaws.com/" })]).success).toBe(true);
    for (const apiUrl of [
      "http://ec2.amazonaws.com",
      "https://ec2.amazonaws.com/v1",
      "https://ec2.amazonaws.com?region=eu",
      "https://user:pass@ec2.amazonaws.com",
      "https://127.0.0.1",
    ]) {
      expect(parse([provider({ apiUrl })]).success, apiUrl).toBe(false);
    }
    expect(parse([provider({ docsUrl: "javascript:alert(1)" })]).success).toBe(false);
  });

  it("refuses credential fields a form couldn't render or keep apart", () => {
    const field = {
      id: "token",
      label: "Token",
      secret: true,
      input: "single-line",
      required: true,
    };
    expect(parse([provider({ credentialFields: [] })]).success).toBe(false);
    expect(parse([provider({ credentialFields: [field, field] })]).success).toBe(false);
    expect(parse([provider({ credentialFields: [{ ...field, id: "constructor" }] })]).success).toBe(
      false
    );
    expect(parse([provider({ credentialFields: [{ ...field, input: "password" }] })]).success).toBe(
      false
    );
    expect(parse([provider({ credentialFields: [{ ...field, label: "  " }] })]).success).toBe(
      false
    );
  });

  it("refuses an SSH declaration that can't be run safely or doesn't add up", () => {
    const capabilities = provider().capabilities;
    const withTunnel = (tunnel: unknown) =>
      parse([provider({ capabilities: { ...capabilities, tunnel } })]).success;
    expect(withTunnel({ command: "aws; rm -rf /", args: [], installUrl: "https://a.com" })).toBe(
      false
    );
    expect(withTunnel({ command: "aws", args: ["$(id)"], installUrl: "https://a.com" })).toBe(
      false
    );
    expect(withTunnel({ command: "aws", args: [], installUrl: "http://a.com" })).toBe(false);
    expect(withTunnel(null)).toBe(false);
    const ssh = (overrides: Record<string, unknown>) =>
      parse([provider({ capabilities: { ...capabilities, ...overrides } })]).success;
    // Each refused for one reason alone, beside a case that differs only in it.
    expect(ssh({ transport: "direct", tunnel: null, sshTrust: "pinned-from-api" })).toBe(true);
    expect(ssh({ transport: "direct", tunnel: null, sshTrust: "provider-tunnel" })).toBe(false);
    expect(ssh({ sshTrust: "pinned-from-api" })).toBe(true);
    // A key confirmed on first connect can't be confirmed through the provider's tunnel.
    expect(ssh({ sshTrust: "confirm-on-first-connect" })).toBe(false);
    // Nor can the API's key be checked against the one the machine presents through it.
    expect(ssh({ transport: "direct", tunnel: null, sshTrust: "api-or-confirm" })).toBe(true);
    expect(ssh({ sshTrust: "api-or-confirm" })).toBe(false);
  });

  it("takes a tunnel's install and sign-in lines only as one visible line each", () => {
    const capabilities = provider().capabilities;
    const withLines = (lines: Record<string, unknown>) =>
      parse([
        provider({
          capabilities: { ...capabilities, tunnel: { ...capabilities.tunnel, ...lines } },
        }),
      ]);
    const accepted = withLines({
      installCommand: "brew install awscli",
      signInCommand: "aws sso login",
    });
    expect(accepted.success).toBe(true);
    expect(
      accepted.success ? accepted.data.contributes.cloudProviders[0]!.capabilities.tunnel : null
    ).toEqual(expect.objectContaining({ signInCommand: "aws sso login" }));
    // Either alone, and neither.
    expect(withLines({ signInCommand: "aws sso login" }).success).toBe(true);
    expect(withLines({ installCommand: "brew install awscli" }).success).toBe(true);
    expect(withLines({}).success).toBe(true);
    // Each refused for one reason: what would submit it, hide part of it, or isn't a line at all.
    for (const line of [
      "",
      " aws sso login",
      "aws sso login\n",
      "aws sso login\nrm -rf ~",
      "aws\u2028sso login",
      "aws \u202esso login",
      "aws\tsso",
      "x".repeat(513),
      42,
    ]) {
      expect(withLines({ signInCommand: line }).success, JSON.stringify(line)).toBe(false);
      expect(withLines({ installCommand: line }).success, JSON.stringify(line)).toBe(false);
    }
    expect(withLines({ signInCommand: "x".repeat(512) }).success).toBe(true);
  });

  it("reads a stop that bills nothing for its disk unless the provider says it does", () => {
    const declared = (persistence: Record<string, unknown>) => {
      const capabilities = provider().capabilities;
      const result = parse([
        provider({
          capabilities: {
            ...capabilities,
            persistence: { ...capabilities.persistence, ...persistence },
          },
        }),
      ]);
      return result.success ? result.data.contributes.cloudProviders[0]!.capabilities : null;
    };
    expect(declared({})?.persistence).toEqual(
      expect.objectContaining({ stoppedStorageBilled: false })
    );
    expect(declared({})?.persistence).not.toHaveProperty("stoppedBilling");
    expect(
      declared({ stoppedStorageBilled: true, stoppedBilling: "A stopped VM bills its IP." })
        ?.persistence
    ).toEqual(
      expect.objectContaining({
        stoppedStorageBilled: true,
        stoppedBilling: "A stopped VM bills its IP.",
      })
    );
    expect(declared({ stoppedStorageBilled: "yes" })).toBeNull();
    expect(declared({ stoppedBilling: " " })).toBeNull();
  });

  it("replays a lost create with its key unless the provider has none", () => {
    const replay = (createReplay?: unknown) => {
      const result = parse([provider(createReplay === undefined ? {} : { createReplay })]);
      return result.success ? result.data.contributes.cloudProviders[0]!.createReplay : "refused";
    };
    expect(replay()).toBeUndefined();
    expect(replay("same-key")).toBe("same-key");
    expect(replay("lookup-only")).toBe("lookup-only");
    expect(replay("never")).toBe("refused");
  });

  it("refuses a capability it doesn't know", () => {
    const capabilities = provider().capabilities;
    expect(
      parse([provider({ capabilities: { ...capabilities, lifetime: { kind: "forever" } } })])
        .success
    ).toBe(false);
    expect(parse([provider({ capabilities: { ...capabilities, gpu: true } })]).success).toBe(false);
  });
});
