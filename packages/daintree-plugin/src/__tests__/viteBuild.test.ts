import { describe, it, expect } from "vitest";
import { resolveViteBin, spawnViteWatch } from "../lib/viteBuild.js";

describe("viteBuild", () => {
  it("resolveViteBin throws a fix-it message when Vite isn't installed", () => {
    expect(() => resolveViteBin("/nonexistent/plugin/dir")).toThrow(/Couldn't find Vite/);
  });

  it("spawnViteWatch is synchronous so it returns a live child handle, not a process-exit promise", () => {
    // An `async` spawnViteWatch would unwrap execa's ResultPromise and resolve
    // only on the watcher's exit, hanging the dev loop. Lock it as a plain fn.
    expect(spawnViteWatch.constructor.name).toBe("Function");
  });
});
