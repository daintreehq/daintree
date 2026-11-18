import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CloudProviderContribution,
  CloudProviderImpl,
} from "../../../../shared/types/pluginCloudProvider.js";
import {
  PluginCloudProviderAnswerError,
  PluginCloudProviderTransportError,
  cloudProviderWireArgs,
  decodeCloudProviderAnswer,
  encodeCloudProviderAnswer,
  unsendableCloudProviderAnswer,
} from "../pluginCloudProviderCalls.js";
import {
  bindPluginCloudProvider,
  clearPluginCloudProviders,
  forgetPluginCloudProviderConsent,
  setPluginCloudConsentForgetter,
  listPluginCloudProviders,
  onPluginCloudProvidersChanged,
  pluginCloudProviderBinding,
  pluginCloudProviderUnavailableReason,
  publishPluginCloudProviders,
  setPluginCloudProviderRuntime,
  unbindPluginCloudProviders,
  withdrawPluginCloudProviders,
} from "../pluginCloudProviders.js";

function contribution(
  overrides: Partial<CloudProviderContribution> = {}
): CloudProviderContribution {
  return {
    id: "ec2",
    name: "EC2",
    description: "Machines on your AWS account.",
    apiUrl: "https://ec2.example.com",
    apiKeyUrl: "https://console.example.com/keys",
    dashboardUrl: "https://console.example.com",
    docsUrl: "https://docs.example.com",
    credentialFields: [
      {
        id: "accessKeyId",
        label: "Access key ID",
        secret: false,
        input: "single-line",
        required: true,
        help: null,
      },
    ],
    capabilities: {
      persistence: {
        kept: "Its disk",
        lost: "Memory",
        retentionDays: null,
        saveRetryBilled: false,
        stoppedComputeBilled: false,
        stoppedStorageBilled: false,
      },
      typicalStartSeconds: 60,
      lifetime: { kind: "none" },
      sshTrust: "confirm-on-first-connect",
      transport: "direct",
      tunnel: null,
      provisioning: { location: "none", image: "none", network: "none", sshKey: "at-create" },
      deletion: true,
    },
    ...overrides,
  };
}

function impl(overrides: Partial<CloudProviderImpl> = {}): CloudProviderImpl {
  const unused = () => {
    throw new Error("unused");
  };
  return {
    checkCredentials: unused,
    validate: unused,
    catalog: unused,
    list: unused,
    inspect: unused,
    create: unused,
    start: unused,
    stop: unused,
    rename: unused,
    delete: unused,
    sshAccess: unused,
    ...overrides,
  };
}

/** The binding for `providerId` as the provider registered from the current load sees it. */
function bindingOf(providerId: string) {
  const declaration = listPluginCloudProviders().find((d) => d.providerId === providerId);
  return declaration ? pluginCloudProviderBinding(declaration) : undefined;
}

afterEach(() => clearPluginCloudProviders());

describe("plugin cloud provider declarations", () => {
  it("publishes a plugin's providers under its namespace and tells listeners", () => {
    const listener = vi.fn();
    onPluginCloudProvidersChanged(listener);
    publishPluginCloudProviders("acme.clouds", [contribution(), contribution({ id: "gce" })]);
    expect(listPluginCloudProviders().map((d) => d.providerId)).toEqual([
      "acme.clouds.ec2",
      "acme.clouds.gce",
    ]);
    expect(listener).toHaveBeenCalledTimes(1);

    withdrawPluginCloudProviders("acme.clouds");
    expect(listPluginCloudProviders()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    // Withdrawing what was never published changes nothing, and says nothing.
    withdrawPluginCloudProviders("acme.clouds");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("gives a reload fresh declarations that no binding of the last load answers for", () => {
    publishPluginCloudProviders("acme.clouds", [contribution(), contribution({ id: "gce" })]);
    const [before] = listPluginCloudProviders();
    bindPluginCloudProvider("acme.clouds", "ec2", impl());
    expect(pluginCloudProviderBinding(before!)).toBeDefined();
    publishPluginCloudProviders("acme.clouds", [contribution()]);
    const [after] = listPluginCloudProviders();
    expect(after).not.toBe(before);
    expect(pluginCloudProviderBinding(after!)).toBeUndefined();
    // An adapter still holding the old declaration finds nothing either.
    expect(pluginCloudProviderBinding(before!)).toBeUndefined();
  });

  it("withdraws one plugin's providers and bindings, leaving another plugin's", () => {
    publishPluginCloudProviders("acme.clouds", [contribution()]);
    publishPluginCloudProviders("other.clouds", [contribution()]);
    bindPluginCloudProvider("acme.clouds", "ec2", impl());
    bindPluginCloudProvider("other.clouds", "ec2", impl());
    const [acme, other] = listPluginCloudProviders();
    withdrawPluginCloudProviders("acme.clouds");
    expect(pluginCloudProviderBinding(acme!)).toBeUndefined();
    expect(pluginCloudProviderBinding(other!)).toBeDefined();
    expect(listPluginCloudProviders().map((d) => d.providerId)).toEqual(["other.clouds.ec2"]);
  });
});

describe("binding a plugin's cloud provider", () => {
  it("refuses an id the manifest doesn't declare, and an impl missing what the declaration needs", () => {
    publishPluginCloudProviders("acme.clouds", [
      contribution({
        capabilities: {
          ...contribution().capabilities,
          lifetime: { kind: "renewable" },
          provisioning: {
            location: "none",
            image: "none",
            network: "none",
            sshKey: "after-create",
          },
        },
      }),
    ]);
    expect(() => bindPluginCloudProvider("acme.clouds", "gce", impl())).toThrow(/not declared/);
    expect(() => bindPluginCloudProvider("other.plugin", "ec2", impl())).toThrow(/not declared/);
    expect(() => bindPluginCloudProvider("acme.clouds", "ec2", impl())).toThrow(
      /has no renewLifetime, authorizeSsh/
    );
    const { stop: _stop, ...noStop } = impl({
      renewLifetime: () => ({}) as never,
      authorizeSsh: () => ({}) as never,
    });
    expect(() =>
      bindPluginCloudProvider("acme.clouds", "ec2", noStop as CloudProviderImpl)
    ).toThrow(/has no stop$/);
    expect(bindingOf("acme.clouds.ec2")).toBeUndefined();
  });

  it("calls the impl with the signal where the contract puts it, and keeps a named failure's code", async () => {
    publishPluginCloudProviders("acme.clouds", [contribution()]);
    const checkCredentials = vi.fn(async () => ({ identity: "me", scopes: [] }));
    const inspect = vi.fn(async () => {
      throw Object.assign(new Error("No capacity\nin us-east-1a"), { code: "capacity" });
    });
    const rename = vi.fn(async () => {
      throw new Error("boom");
    });
    bindPluginCloudProvider("acme.clouds", "ec2", impl({ checkCredentials, inspect, rename }));
    const binding = bindingOf("acme.clouds.ec2")!;
    const signal = new AbortController().signal;

    await binding.call(
      "checkCredentials",
      [{ accessKeyId: "x" }, "https://ec2.example.com"],
      signal
    );
    expect(checkCredentials).toHaveBeenCalledWith(
      { accessKeyId: "x" },
      "https://ec2.example.com",
      signal
    );

    const credentials = { values: { accessKeyId: "x" }, scopeId: "s", apiUrl: "https://e.com" };
    const failure = await binding.call("inspect", [credentials, "i-1"], signal).catch((e) => e);
    expect(failure).toBeInstanceOf(PluginCloudProviderAnswerError);
    expect(failure).toMatchObject({ code: "capacity", message: "No capacity in us-east-1a" });
    expect(inspect).toHaveBeenCalledWith({ ...credentials, signal }, "i-1");

    await expect(binding.call("rename", [credentials, "i-1", "n"], signal)).rejects.toMatchObject({
      code: null,
      message: "boom",
    });
  });

  it("passes a worker proxy's own verdict through, transport failure included", async () => {
    publishPluginCloudProviders("acme.clouds", [contribution()]);
    bindPluginCloudProvider(
      "acme.clouds",
      "ec2",
      impl({
        validate: async () => {
          throw new PluginCloudProviderTransportError("worker gone");
        },
      })
    );
    await expect(
      bindingOf("acme.clouds.ec2")!.call("validate", [{}], new AbortController().signal)
    ).rejects.toBeInstanceOf(PluginCloudProviderTransportError);
  });

  it("lets a replaced binding's disposer leave its successor, and drops a plugin's bindings on unbind", () => {
    publishPluginCloudProviders("acme.clouds", [contribution()]);
    const first = bindPluginCloudProvider("acme.clouds", "ec2", impl());
    bindPluginCloudProvider("acme.clouds", "ec2", impl());
    const current = bindingOf("acme.clouds.ec2");
    first();
    expect(bindingOf("acme.clouds.ec2")).toBe(current);
    unbindPluginCloudProviders("acme.clouds");
    expect(bindingOf("acme.clouds.ec2")).toBeUndefined();
  });
});

describe("why a plugin's provider isn't there", () => {
  it("asks the plugin service, says nothing of a built-in id, and words its absence without one", () => {
    expect(pluginCloudProviderUnavailableReason("boat")).toBeNull();
    expect(pluginCloudProviderUnavailableReason("acme.clouds.ec2")).toContain("acme.clouds");
    setPluginCloudProviderRuntime({
      activate: async () => {},
      isActivated: () => false,
      unavailableReason: (pluginId, providerId) => `${pluginId} is off (${providerId})`,
      startFailure: () => null,
    });
    expect(pluginCloudProviderUnavailableReason("acme.clouds.ec2")).toBe(
      "acme.clouds is off (acme.clouds.ec2)"
    );
  });
});

describe("cloud provider answers across the port", () => {
  it("round-trips a value, and a failure with its code but not one Daintree doesn't know", () => {
    expect(decodeCloudProviderAnswer(encodeCloudProviderAnswer({ ok: true, value: [1] }))).toEqual([
      1,
    ]);
    expect(
      decodeCloudProviderAnswer(encodeCloudProviderAnswer({ ok: true, value: undefined }))
    ).toBe(null);
    const named = Object.assign(new Error("over quota"), { code: "billing" });
    expect(() =>
      decodeCloudProviderAnswer(encodeCloudProviderAnswer({ ok: false, error: named }))
    ).toThrow(expect.objectContaining({ code: "billing", message: "over quota" }));
    const unknown = Object.assign(new Error("nope"), { code: "teapot" });
    expect(() =>
      decodeCloudProviderAnswer(encodeCloudProviderAnswer({ ok: false, error: unknown }))
    ).toThrow(expect.objectContaining({ code: null }));
    expect(() => decodeCloudProviderAnswer("{not json")).toThrow(PluginCloudProviderTransportError);
    expect(() => decodeCloudProviderAnswer({ ok: true })).toThrow(
      PluginCloudProviderTransportError
    );
  });

  it("reads an envelope only as the worker writes one", () => {
    // A success with no value (a function answer JSON dropped) was never a whole answer.
    expect(() => decodeCloudProviderAnswer('{"ok":true}')).toThrow(
      PluginCloudProviderTransportError
    );
    expect(decodeCloudProviderAnswer('{"ok":true,"value":null}')).toBeNull();
    expect(() => decodeCloudProviderAnswer('{"ok":false,"code":"capacity"}')).toThrow(
      expect.objectContaining({ code: "capacity" })
    );
    expect(() => decodeCloudProviderAnswer('{"ok":false,"code":"teapot"}')).toThrow(
      expect.objectContaining({ code: null })
    );
    // Counted in bytes, as the worker counts them: under the limit in characters isn't enough.
    const wide = JSON.stringify({ ok: true, value: "€".repeat(400_000) });
    expect(wide.length).toBeLessThan(1024 * 1024);
    expect(() => decodeCloudProviderAnswer(wide)).toThrow(PluginCloudProviderTransportError);
  });

  it("keeps a named failure's code when its message can't be read, and the reverse", () => {
    const codeOnly = { code: "billing" };
    Object.defineProperty(codeOnly, "message", {
      get() {
        throw new Error("no");
      },
    });
    expect(PluginCloudProviderAnswerError.from(codeOnly)).toMatchObject({ code: "billing" });
    const messageOnly = { message: "over quota" };
    Object.defineProperty(messageOnly, "code", {
      get() {
        throw new Error("no");
      },
    });
    expect(PluginCloudProviderAnswerError.from(messageOnly)).toMatchObject({
      code: null,
      message: "over quota",
    });
  });

  it("answers an unsendable result with a failure no one can read as a refusal", () => {
    expect(() => decodeCloudProviderAnswer(unsendableCloudProviderAnswer())).toThrow(
      expect.objectContaining({ code: null })
    );
  });

  it("refuses an answer over the size limit before it crosses", () => {
    expect(() =>
      encodeCloudProviderAnswer({ ok: true, value: "x".repeat(2 * 1024 * 1024) })
    ).toThrow(/limit/);
  });

  it("keeps the signal on this side of the port", () => {
    const signal = new AbortController().signal;
    expect(
      cloudProviderWireArgs("checkCredentials", [{ k: "v" }, "https://a.com", signal])
    ).toEqual({ args: [{ k: "v" }, "https://a.com"], signal });
    expect(
      cloudProviderWireArgs("stop", [{ values: {}, scopeId: "s", apiUrl: "u", signal }, "i-1"])
    ).toEqual({ args: [{ values: {}, scopeId: "s", apiUrl: "u" }, "i-1"], signal });
  });
});

describe("consent to a plugin's cloud providers", () => {
  afterEach(() => clearPluginCloudProviders());

  function fingerprintAfter(contributions: CloudProviderContribution[]): string {
    publishPluginCloudProviders("acme.clouds", contributions, "Acme Clouds");
    const prints = new Set(listPluginCloudProviders().map((entry) => entry.consentFingerprint));
    expect(prints.size).toBe(1);
    return [...prints][0]!;
  }

  it("names the plugin, by its id when it has no display name, with one fingerprint for all its providers", () => {
    publishPluginCloudProviders(
      "acme.clouds",
      [contribution(), contribution({ id: "gce" })],
      "Acme"
    );
    const declared = listPluginCloudProviders();
    expect(declared.map((entry) => entry.pluginName)).toEqual(["Acme", "Acme"]);
    expect(declared[0]!.consentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(declared[1]!.consentFingerprint).toBe(declared[0]!.consentFingerprint);
    publishPluginCloudProviders("other.clouds", [contribution()], "  ");
    expect(
      listPluginCloudProviders().find((entry) => entry.pluginId === "other.clouds")!.pluginName
    ).toBe("other.clouds");
  });

  it("keeps it for an update that only rewords, reorders or restates a default", () => {
    const before = fingerprintAfter([contribution(), contribution({ id: "gce", name: "GCE" })]);
    const reworded = fingerprintAfter([
      contribution({ id: "gce", name: "Compute" }),
      contribution({
        name: "Elastic Compute",
        description: "Other words.",
        apiUrl: "https://ec2.example.com/",
        apiKeyUrl: "https://elsewhere.example.com/keys",
        dashboardUrl: "https://elsewhere.example.com",
        docsUrl: "https://elsewhere.example.com/docs",
        createReplay: "same-key",
      }),
    ]);
    expect(reworded).toBe(before);
  });

  it("changes it when a provider asks for or does something else, or one is added", () => {
    const base = contribution();
    const before = fingerprintAfter([base]);
    const changed = [
      [contribution({ capabilities: { ...base.capabilities, deletion: false } })],
      [contribution({ capabilities: { ...base.capabilities, sshTrust: "pinned-from-api" } })],
      [contribution({ credentialFields: [{ ...base.credentialFields[0]!, secret: true }] })],
      [contribution({ apiUrl: "https://ec2.elsewhere.example.com" })],
      [contribution({ createReplay: "lookup-only" })],
      [base, contribution({ id: "gce" })],
      // The same provider under another id: the count and every other field unchanged.
      [contribution({ id: "ec2-classic" })],
    ];
    const prints = changed.map((contributions) => fingerprintAfter(contributions));
    expect(prints).not.toContain(before);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it("forgets an uninstalled plugin's consent, holding one heard before the cloud side was there", () => {
    forgetPluginCloudProviderConsent("early.clouds");
    const forgotten: string[] = [];
    setPluginCloudConsentForgetter((pluginId) => forgotten.push(pluginId));
    expect(forgotten).toEqual(["early.clouds"]);
    forgetPluginCloudProviderConsent("acme.clouds");
    expect(forgotten).toEqual(["early.clouds", "acme.clouds"]);
    // Heard once: a forgetter set again doesn't replay it.
    setPluginCloudConsentForgetter(null);
    const later: string[] = [];
    setPluginCloudConsentForgetter((pluginId) => later.push(pluginId));
    expect(later).toEqual([]);
  });

  it("keeps a held forget whose write failed for the next forgetter", () => {
    setPluginCloudConsentForgetter(null);
    forgetPluginCloudProviderConsent("acme.clouds");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setPluginCloudConsentForgetter(() => {
      throw new Error("disk full");
    });
    const forgotten: string[] = [];
    setPluginCloudConsentForgetter((pluginId) => forgotten.push(pluginId));
    expect(forgotten).toEqual(["acme.clouds"]);
    error.mockRestore();
  });
});
