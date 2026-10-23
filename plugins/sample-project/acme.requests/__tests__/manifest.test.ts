import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { narrationFingerprint, parseNarration } from "@daintreehq/tour";
import { MIGRATIONS } from "../src/store";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
const narration = JSON.parse(
  readFileSync(path.join(root, "tours", "welcome.narration.json"), "utf8")
) as { chapters: Array<{ id: string; narration: string }> };

describe("Request Desk manifest", () => {
  it("declares the requests database at the schema version its migrations reach", () => {
    const db = manifest.contributes.databases.find(
      (entry: { id: string }) => entry.id === "requests"
    );
    expect(db.schemaVersion).toBe(MIGRATIONS.length);
  });

  it("carries tour timing made from the narration as it is now", () => {
    const tour = manifest.contributes.tours.find((entry: { id: string }) => entry.id === "welcome");
    expect(tour.chapters.map((chapter: { id: string }) => chapter.id)).toEqual(
      narration.chapters.map((chapter) => chapter.id)
    );
    for (const chapter of narration.chapters) {
      const entry = tour.chapters.find((c: { id: string }) => c.id === chapter.id);
      // A stale hash means the script changed after the timing was made:
      // run `daintree-plugin tour voice` (or refresh the estimate).
      expect(entry.narrationHash).toBe(narrationFingerprint(parseNarration(chapter.narration)));
    }
  });
});
