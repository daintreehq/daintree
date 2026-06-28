import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveSettingsTemplates,
  substituteSettingsTemplates,
  SettingTemplateError,
  type PluginSettingsApi,
} from "../settingsTemplateResolver.js";

function fakeApi(values: Record<string, string | undefined>): PluginSettingsApi {
  return {
    get: vi.fn(async (key: string) => {
      const v = values[key];
      if (v === undefined && !(key in values)) {
        return undefined;
      }
      return v;
    }),
  };
}

function throwingApi(errors: Record<string, Error>): PluginSettingsApi {
  return {
    get: vi.fn(async (key: string) => {
      if (key in errors) {
        throw errors[key];
      }
      return undefined;
    }),
  };
}

let api: ReturnType<typeof fakeApi>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSettingsTemplates", () => {
  describe("substitution", () => {
    it("substitutes a single ${settings:id} template", async () => {
      api = fakeApi({ "linear.apiToken": "sk-abc123" });
      const result = await resolveSettingsTemplates(
        "Bearer ${settings:linear.apiToken}",
        "acme.linear",
        api
      );
      expect(result).toBe("Bearer sk-abc123");
    });

    it("substitutes multiple distinct templates", async () => {
      api = fakeApi({ apiToken: "sk-abc", orgId: "org-42" });
      const result = await resolveSettingsTemplates(
        "${settings:apiToken}:${settings:orgId}",
        "acme.plugin",
        api
      );
      expect(result).toBe("sk-abc:org-42");
    });

    it("substitutes templates embedded in literal text", async () => {
      api = fakeApi({ token: "sk-xyz" });
      const result = await resolveSettingsTemplates(
        "KEY=${settings:token}&other=val",
        "acme.plugin",
        api
      );
      expect(result).toBe("KEY=sk-xyz&other=val");
    });

    it("supports underscore keys", async () => {
      api = fakeApi({ api_key: "secret123" });
      const result = await resolveSettingsTemplates("${settings:api_key}", "acme.plugin", api);
      expect(result).toBe("secret123");
    });

    it("supports dot-separated keys", async () => {
      api = fakeApi({ "linear.apiToken": "sk-dot" });
      const result = await resolveSettingsTemplates(
        "${settings:linear.apiToken}",
        "acme.linear",
        api
      );
      expect(result).toBe("sk-dot");
    });

    it("substitutes a hyphenated id (matches the schema's any-non-empty-string id grammar)", async () => {
      api = fakeApi({ "linear-api-token": "sk-hyphen" });
      const result = await resolveSettingsTemplates(
        "Bearer ${settings:linear-api-token}",
        "acme.linear",
        api
      );
      expect(result).toBe("Bearer sk-hyphen");
      expect(api.get).toHaveBeenCalledWith("linear-api-token");
    });

    it("deduplicates lookups for repeated keys", async () => {
      api = fakeApi({ token: "once" });
      const result = await resolveSettingsTemplates(
        "${settings:token}-${settings:token}",
        "acme.plugin",
        api
      );
      expect(result).toBe("once-once");
      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get).toHaveBeenCalledWith("token");
    });

    it("returns empty string when get() returns empty string (valid value)", async () => {
      api = fakeApi({ token: "" });
      const result = await resolveSettingsTemplates(
        "prefix-${settings:token}-suffix",
        "acme.plugin",
        api
      );
      expect(result).toBe("prefix--suffix");
    });

    it("returns text unchanged when no templates present", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("plain text no templates", "acme.plugin", api);
      expect(result).toBe("plain text no templates");
      expect(api.get).not.toHaveBeenCalled();
    });

    it("returns empty string for empty text input", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("", "acme.plugin", api);
      expect(result).toBe("");
    });
  });

  describe("near-misses pass through as literal", () => {
    it("leaves $settings:foo unchanged (missing braces)", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("$settings:foo", "acme.plugin", api);
      expect(result).toBe("$settings:foo");
      expect(api.get).not.toHaveBeenCalled();
    });

    it("leaves ${settings:} unchanged (empty key)", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("${settings:}", "acme.plugin", api);
      expect(result).toBe("${settings:}");
      expect(api.get).not.toHaveBeenCalled();
    });

    it("leaves ${other:foo} unchanged (wrong namespace)", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("${other:foo}", "acme.plugin", api);
      expect(result).toBe("${other:foo}");
      expect(api.get).not.toHaveBeenCalled();
    });
  });

  // The schema (electron/schemas/plugin.ts) accepts any non-empty string as a
  // setting id, so the resolver's grammar must too — these forms are all valid
  // declared ids that previously passed through unresolved.
  describe("schema-aligned ids substitute", () => {
    it("substitutes an id starting with a digit", async () => {
      api = fakeApi({ "1foo": "digit-led" });
      const result = await resolveSettingsTemplates("${settings:1foo}", "acme.plugin", api);
      expect(result).toBe("digit-led");
      expect(api.get).toHaveBeenCalledWith("1foo");
    });

    it("substitutes a hyphenated id", async () => {
      api = fakeApi({ "foo-bar": "hyphenated" });
      const result = await resolveSettingsTemplates("${settings:foo-bar}", "acme.plugin", api);
      expect(result).toBe("hyphenated");
      expect(api.get).toHaveBeenCalledWith("foo-bar");
    });

    it("substitutes an id with a trailing dot", async () => {
      api = fakeApi({ "foo.": "trailing-dot" });
      const result = await resolveSettingsTemplates("${settings:foo.}", "acme.plugin", api);
      expect(result).toBe("trailing-dot");
      expect(api.get).toHaveBeenCalledWith("foo.");
    });

    it("substitutes an id with a leading dot", async () => {
      api = fakeApi({ ".foo": "leading-dot" });
      const result = await resolveSettingsTemplates("${settings:.foo}", "acme.plugin", api);
      expect(result).toBe("leading-dot");
      expect(api.get).toHaveBeenCalledWith(".foo");
    });

    it("substitutes an id with a double dot", async () => {
      api = fakeApi({ "foo..bar": "double-dot" });
      const result = await resolveSettingsTemplates("${settings:foo..bar}", "acme.plugin", api);
      expect(result).toBe("double-dot");
      expect(api.get).toHaveBeenCalledWith("foo..bar");
    });
  });

  describe("escape", () => {
    it("leaves backslash-escaped template unchanged", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("\\${settings:foo}", "acme.plugin", api);
      expect(result).toBe("\\${settings:foo}");
      expect(api.get).not.toHaveBeenCalled();
    });

    it("resolves adjacent unescaped template while leaving escaped one, distinct keys", async () => {
      api = fakeApi({ public: "ok" });
      const result = await resolveSettingsTemplates(
        "\\${settings:secret} ${settings:public}",
        "acme.plugin",
        api
      );
      expect(result).toBe("\\${settings:secret} ok");
      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get).toHaveBeenCalledWith("public");
    });
  });

  describe("errors", () => {
    it("throws SettingTemplateError for unmatched setting", async () => {
      api = fakeApi({});
      await expect(
        resolveSettingsTemplates("${settings:missing}", "acme.plugin", api)
      ).rejects.toThrow(SettingTemplateError);
    });

    it("includes the pluginId and token in the error", async () => {
      api = fakeApi({});
      let caught: SettingTemplateError | null = null;
      try {
        await resolveSettingsTemplates("${settings:missing.key}", "acme.linear", api);
      } catch (e) {
        caught = e as SettingTemplateError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe("UNMATCHED_SETTING");
      expect(caught!.pluginId).toBe("acme.linear");
      expect(caught!.token).toBe("missing.key");
    });

    it("error message contains the token id, not any resolved value", async () => {
      api = fakeApi({ known: "secret-value" });
      try {
        await resolveSettingsTemplates("${settings:known}${settings:missing}", "acme.plugin", api);
      } catch (e) {
        expect((e as Error).message).toContain("missing");
        expect((e as Error).message).not.toContain("secret-value");
      }
    });

    it("has exact error shape for mixed known+missing", async () => {
      api = fakeApi({ known: "secret" });
      let caught: SettingTemplateError | null = null;
      try {
        await resolveSettingsTemplates("${settings:known}${settings:missing}", "acme.plugin", api);
      } catch (e) {
        caught = e as SettingTemplateError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe("UNMATCHED_SETTING");
      expect(caught!.pluginId).toBe("acme.plugin");
      expect(caught!.token).toBe("missing");
      expect(caught!.message).toBe('Unmatched setting template "missing" for plugin "acme.plugin"');
    });

    it("fails the entire call when any one setting is missing (no partial substitution)", async () => {
      api = fakeApi({ good: "resolved" });
      await expect(
        resolveSettingsTemplates("${settings:good}${settings:bad}", "acme.plugin", api)
      ).rejects.toThrow(SettingTemplateError);
    });

    it("wraps get() rejection in SettingTemplateError, hiding backend details", async () => {
      const api2 = throwingApi({
        secretKey: new Error("decrypt failed: sk-live-secret"),
      });
      let caught: SettingTemplateError | null = null;
      try {
        await resolveSettingsTemplates("${settings:secretKey}", "acme.plugin", api2);
      } catch (e) {
        caught = e as SettingTemplateError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe("UNMATCHED_SETTING");
      expect(caught!.token).toBe("secretKey");
      expect(caught!.message).not.toContain("decrypt");
      expect(caught!.message).not.toContain("sk-live-secret");
    });
  });
});

describe("substituteSettingsTemplates", () => {
  it("substitutes each unique id once via the resolve callback", async () => {
    const resolve = vi.fn(async (id: string) => ({ apiToken: "sk-1", orgId: "org-2" })[id] ?? "");
    const result = await substituteSettingsTemplates(
      "--token ${settings:apiToken} --org ${settings:orgId} --again ${settings:apiToken}",
      resolve
    );
    expect(result).toBe("--token sk-1 --org org-2 --again sk-1");
    // apiToken appears twice but is resolved once (dedup), orgId once → 2 calls.
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("returns the input unchanged (and never calls resolve) when no template is present", async () => {
    const resolve = vi.fn(async () => "x");
    const result = await substituteSettingsTemplates("acme --interactive", resolve);
    expect(result).toBe("acme --interactive");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("propagates an error thrown by resolve (caller decides unset-means-error)", async () => {
    const resolve = vi.fn(async (id: string) => {
      if (id === "missing") throw new SettingTemplateError("acme.plugin", id);
      return "ok";
    });
    await expect(
      substituteSettingsTemplates("${settings:present} ${settings:missing}", resolve)
    ).rejects.toThrow(SettingTemplateError);
  });

  it("leaves near-miss syntax untouched", async () => {
    const resolve = vi.fn(async () => "x");
    const result = await substituteSettingsTemplates(
      "$settings:foo ${settings:} ${other:foo}",
      resolve
    );
    expect(result).toBe("$settings:foo ${settings:} ${other:foo}");
    expect(resolve).not.toHaveBeenCalled();
  });
});
