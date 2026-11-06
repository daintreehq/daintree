import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFile(...args),
}));

vi.mock("../../../../../electron/utils/windowsExecutable.js", () => ({
  resolveExecutableForSpawn: async (name: string) => `/resolved/${name}`,
}));

import { clearActorCache, resolveActor } from "../actor.js";

function gitAnswers(...answers: Array<string | Error>) {
  for (const answer of answers) {
    execFile.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (e: Error | null, out: string) => void
      ) => (answer instanceof Error ? cb(answer, "") : cb(null, answer))
    );
  }
}

beforeEach(() => {
  execFile.mockReset();
  clearActorCache();
  vi.stubEnv("BEADS_ACTOR", "");
  vi.stubEnv("BD_ACTOR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveActor", () => {
  it("takes BEADS_ACTOR first, without asking git", async () => {
    vi.stubEnv("BEADS_ACTOR", " ada ");
    await expect(resolveActor()).resolves.toBe("ada");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls back to git's global user.name through the resolved executable, and keeps it", async () => {
    gitAnswers("Grace Hopper\n");
    await expect(resolveActor()).resolves.toBe("Grace Hopper");
    await expect(resolveActor()).resolves.toBe("Grace Hopper");
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][0]).toBe("/resolved/git");
    expect(execFile.mock.calls[0][1]).toEqual(["config", "--global", "user.name"]);
  });

  it("uses the OS user when git has no name, and asks git again next time", async () => {
    gitAnswers(new Error("no git"), "Linus\n");
    const first = await resolveActor();
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toBe("Linus");
    await expect(resolveActor()).resolves.toBe("Linus");
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});
