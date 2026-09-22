import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { minimalSpawnEnv, minimalWorkerEnv } from "../minimalSpawnEnv.js";

const originalEnv = process.env;
const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p });
}

function keysNamed(env: NodeJS.ProcessEnv, name: string): string[] {
  return Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase());
}

describe("minimalSpawnEnv case handling", () => {
  beforeEach(() => {
    process.env = { PATH: "/host/bin", HTTPS_PROXY: "http://host-proxy:3128" };
  });

  afterEach(() => {
    process.env = originalEnv;
    setPlatform(originalPlatform);
  });

  it("lets a differently-cased override replace the allowlisted key on Windows", () => {
    setPlatform("win32");
    const env = minimalSpawnEnv({ Path: "C:\\custom\\bin" });
    // One entry per case-insensitive name — a second `PATH` would sort ahead
    // of `Path` in the child's environment block and win.
    expect(keysNamed(env, "PATH")).toEqual(["Path"]);
    expect(env.Path).toBe("C:\\custom\\bin");
  });

  it("applies the same fold to the network keys minimalWorkerEnv adds", () => {
    setPlatform("win32");
    const env = minimalWorkerEnv({ https_proxy: "http://manifest-proxy:8080" });
    expect(keysNamed(env, "HTTPS_PROXY")).toEqual(["https_proxy"]);
    expect(env.https_proxy).toBe("http://manifest-proxy:8080");
  });

  it("keeps differently-cased names distinct on POSIX, where they are separate variables", () => {
    setPlatform("linux");
    const env = minimalSpawnEnv({ Path: "/custom/bin" });
    expect(env.PATH).toBe("/host/bin");
    expect(env.Path).toBe("/custom/bin");
  });
});
