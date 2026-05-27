import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveSettingsTemplates,
  SettingTemplateError,
  type PluginSettingsApi,
} from "../settingsTemplateResolver.js";

function fakeApi(values: Record<string, string | undefined>): PluginSettingsApi {
  return {
    get: vi.fn(async (key: string) => values[key]),
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

    it("leaves ${settings:1foo} unchanged (starts with digit)", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("${settings:1foo}", "acme.plugin", api);
      expect(result).toBe("${settings:1foo}");
      expect(api.get).not.toHaveBeenCalled();
    });

    it("leaves ${settings:foo-bar} unchanged (hyphen in key)", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("${settings:foo-bar}", "acme.plugin", api);
      expect(result).toBe("${settings:foo-bar}");
      expect(api.get).not.toHaveBeenCalled();
    });
  });

  describe("escape", () => {
    it("leaves backslash-escaped template unchanged", async () => {
      api = fakeApi({});
      const result = await resolveSettingsTemplates("\\${settings:foo}", "acme.plugin", api);
      expect(result).toBe("\\${settings:foo}");
      expect(api.get).not.toHaveBeenCalled();
    });

    it("resolves adjacent unescaped template while leaving escaped one", async () => {
      api = fakeApi({ foo: "bar" });
      const result = await resolveSettingsTemplates(
        "\\${settings:foo} ${settings:foo}",
        "acme.plugin",
        api
      );
      expect(result).toBe("\\${settings:foo} bar");
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
      await expect(
        resolveSettingsTemplates("${settings:known}${settings:missing}", "acme.plugin", api)
      ).rejects.toThrow("missing");
      // The message must NOT contain the resolved value of "known"
      try {
        await resolveSettingsTemplates("${settings:known}${settings:missing}", "acme.plugin", api);
      } catch (e) {
        expect((e as Error).message).not.toContain("secret-value");
      }
    });

    it("fails the entire call when any one setting is missing (no partial substitution)", async () => {
      api = fakeApi({ good: "resolved" });
      await expect(
        resolveSettingsTemplates("${settings:good}${settings:bad}", "acme.plugin", api)
      ).rejects.toThrow(SettingTemplateError);
    });

    it("throws only once even with multiple unmatched tokens (fail-fast on first)", async () => {
      api = fakeApi({});
      // Both tokens are unmatched — should throw on the first one
      await expect(
        resolveSettingsTemplates("${settings:a}${settings:b}", "acme.plugin", api)
      ).rejects.toThrow("a");
    });
  });
});
