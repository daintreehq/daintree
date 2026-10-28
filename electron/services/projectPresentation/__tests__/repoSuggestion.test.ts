import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashPresentationLevels,
  parsePresentationSuggestion,
  readPresentationSuggestion,
} from "../repoSuggestion.js";

let root: string;

async function writeSuggestion(content: string): Promise<void> {
  await fs.mkdir(path.join(root, ".daintree"), { recursive: true });
  await fs.writeFile(path.join(root, ".daintree", "presentation.json"), content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-suggestion-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("parsePresentationSuggestion", () => {
  it("reads the levels this build knows and hashes them", () => {
    const suggestion = parsePresentationSuggestion({
      features: { forgeStats: "hidden", notAFeature: "hidden" },
    });
    expect(suggestion).toEqual({
      levels: { forgeStats: "hidden" },
      hash: hashPresentationLevels({ forgeStats: "hidden" }),
    });
  });

  it("is no suggestion when nothing usable is left", () => {
    expect(parsePresentationSuggestion({ features: { forgeStats: "gone" } })).toBeNull();
    expect(parsePresentationSuggestion({ features: [] })).toBeNull();
    expect(parsePresentationSuggestion({})).toBeNull();
    expect(parsePresentationSuggestion([])).toBeNull();
  });

  it("hashes what is suggested, not how the file spells it", () => {
    const a = parsePresentationSuggestion({ features: { forgeStats: "demoted" } });
    const b = parsePresentationSuggestion({
      features: { unknownLater: "shown", forgeStats: "demoted" },
      comment: "added by a template",
    });
    expect(a?.hash).toBe(b?.hash);
    expect(a?.hash).not.toBe(hashPresentationLevels({ forgeStats: "hidden" }));
  });
});

describe("featured launcher entry (#13791)", () => {
  it("is a suggestion on its own, and rides beside levels", () => {
    expect(parsePresentationSuggestion({ featuredLaunchEntry: "acme.records.new" })).toEqual({
      levels: {},
      featuredLaunchEntry: "acme.records.new",
      hash: hashPresentationLevels({}, "acme.records.new"),
    });
    expect(
      parsePresentationSuggestion({
        features: { launcherAgents: "demoted" },
        featuredLaunchEntry: "acme.records.new",
      })?.featuredLaunchEntry
    ).toBe("acme.records.new");
  });

  it("ignores a malformed entry and keeps the levels", () => {
    const suggestion = parsePresentationSuggestion({
      features: { forgeStats: "hidden" },
      featuredLaunchEntry: "project__abc__acme.records.new",
    });
    expect(suggestion).toEqual({
      levels: { forgeStats: "hidden" },
      hash: hashPresentationLevels({ forgeStats: "hidden" }),
    });
    expect(parsePresentationSuggestion({ featuredLaunchEntry: 7 })).toBeNull();
  });

  it("hashes a file without one exactly as before, so its answers still count", () => {
    const legacy = createHash("sha256")
      .update(JSON.stringify([["forgeStats", "hidden"]]))
      .digest("hex");
    expect(parsePresentationSuggestion({ features: { forgeStats: "hidden" } })?.hash).toBe(legacy);
    expect(
      parsePresentationSuggestion({
        features: { forgeStats: "hidden" },
        featuredLaunchEntry: "acme.records.new",
      })?.hash
    ).not.toBe(legacy);
  });
});

describe("readPresentationSuggestion", () => {
  it("reads .daintree/presentation.json, BOM and all", async () => {
    await writeSuggestion('﻿{ "features": { "forgeStats": "demoted" } }');
    await expect(readPresentationSuggestion(root)).resolves.toMatchObject({
      levels: { forgeStats: "demoted" },
    });
  });

  it("is silent when there is no file or no project root", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readPresentationSuggestion(root)).resolves.toBeNull();
    await expect(readPresentationSuggestion(null)).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and suggests nothing for malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeSuggestion("{ not json");
    await expect(readPresentationSuggestion(root)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("refuses a file larger than the cap", async () => {
    await writeSuggestion(
      JSON.stringify({ features: { forgeStats: "hidden" }, pad: "x".repeat(70 * 1024) })
    );
    await expect(readPresentationSuggestion(root)).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses a linked file", async () => {
    const outside = path.join(root, "elsewhere.json");
    await fs.writeFile(outside, JSON.stringify({ features: { forgeStats: "hidden" } }));
    await fs.mkdir(path.join(root, ".daintree"));
    await fs.symlink(outside, path.join(root, ".daintree", "presentation.json"));
    await expect(readPresentationSuggestion(root)).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses a linked .daintree directory", async () => {
    const outside = path.join(root, "elsewhere");
    await fs.mkdir(outside);
    await fs.writeFile(
      path.join(outside, "presentation.json"),
      JSON.stringify({ features: { forgeStats: "hidden" } })
    );
    await fs.symlink(outside, path.join(root, ".daintree"));
    await expect(readPresentationSuggestion(root)).resolves.toBeNull();
  });
});
