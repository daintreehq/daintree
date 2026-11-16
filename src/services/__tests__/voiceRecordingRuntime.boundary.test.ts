import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

// The Canopy window is its own entry and always runs the service; it never
// rides in a project view's bundle.
const ALLOWED = new Set(["canopyWindow/canopyWindowKeys.ts"]);

// Re-exports count: a barrel passing the service on loads it as surely.
const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(type\s+)?[^;]*?\s+from\s+"[^"]*\/VoiceRecordingService";/gm;

describe("the recording service's import boundary (#17031)", () => {
  it("is reached in a project view only through the runtime, which loads it on demand", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
      const rel = entry.split(path.sep).join("/");
      if (!/\.tsx?$/.test(rel) || rel.includes("__tests__") || ALLOWED.has(rel)) continue;
      const source = readFileSync(path.join(SRC, entry), "utf8");
      for (const match of source.matchAll(STATIC_IMPORT)) {
        if (!match[1]) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
