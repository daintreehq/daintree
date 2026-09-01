import { describe, expect, it } from "vitest";

import {
  isSafePluginInstanceId,
  makeProjectPluginInstanceKey,
  parseProjectPluginInstanceKey,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../projectPluginIdentity.js";

const PROJECT = "a".repeat(64);

describe("project plugin instance keys", () => {
  it("round-trips a project id and a manifest id", () => {
    const key = makeProjectPluginInstanceKey(PROJECT, "acme.dashboard");
    expect(parseProjectPluginInstanceKey(key)).toEqual({
      projectId: PROJECT,
      manifestId: "acme.dashboard",
    });
    expect(pluginManifestIdFromInstanceKey(key)).toBe("acme.dashboard");
    expect(projectIdFromPluginInstanceKey(key)).toBe(PROJECT);
  });

  it("treats a bare manifest id as its own identity", () => {
    expect(parseProjectPluginInstanceKey("acme.dashboard")).toBe(null);
    expect(pluginManifestIdFromInstanceKey("acme.dashboard")).toBe("acme.dashboard");
    expect(projectIdFromPluginInstanceKey("acme.dashboard")).toBe(null);
  });

  it("keeps two projects' keys distinct for the same manifest id", () => {
    const a = makeProjectPluginInstanceKey("a".repeat(64), "acme.dashboard");
    const b = makeProjectPluginInstanceKey("b".repeat(64), "acme.dashboard");
    expect(a).not.toBe(b);
  });

  it("contains no character that is a path separator or illegal on Windows", () => {
    const key = makeProjectPluginInstanceKey(PROJECT, "acme.dashboard");
    for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
      expect(key).not.toContain(ch);
    }
    expect(key.includes("..")).toBe(false);
  });
});

describe("isSafePluginInstanceId", () => {
  it("accepts a scoped manifest id", () => {
    expect(isSafePluginInstanceId("acme.dashboard")).toBe(true);
    expect(isSafePluginInstanceId("acme-co.deploy-board")).toBe(true);
  });

  it("accepts a well-formed project instance key", () => {
    expect(isSafePluginInstanceId(makeProjectPluginInstanceKey(PROJECT, "acme.dashboard"))).toBe(
      true
    );
  });

  it("rejects traversal, separators and malformed halves", () => {
    expect(isSafePluginInstanceId("../../etc/passwd")).toBe(false);
    expect(isSafePluginInstanceId("acme/dashboard")).toBe(false);
    expect(isSafePluginInstanceId("")).toBe(false);
    expect(isSafePluginInstanceId("project__")).toBe(false);
    expect(isSafePluginInstanceId("project__not-a-project-id__acme.dashboard")).toBe(false);
    expect(isSafePluginInstanceId(`project__${PROJECT}__../evil`)).toBe(false);
    expect(isSafePluginInstanceId(`project__${PROJECT}__nodot`)).toBe(false);
  });
});
