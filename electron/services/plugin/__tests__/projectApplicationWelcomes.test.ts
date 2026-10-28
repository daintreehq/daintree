import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import { getProjectWelcome, setProjectWelcome } from "../projectApplicationWelcomes.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const OWNER = "acme.ledger";

describe("projectApplicationWelcomes (#14106)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("has no answer until the user gives one", () => {
    expect(getProjectWelcome(PROJECT_A, OWNER, "welcome")).toBeNull();
  });

  it("keeps the answer per project, plugin, tour and revision", () => {
    expect(setProjectWelcome(PROJECT_A, OWNER, "welcome", 1, "skipped", 5)).toEqual({
      version: 1,
      status: "skipped",
      at: 5,
    });
    expect(getProjectWelcome(PROJECT_A, OWNER, "welcome")).toEqual({
      version: 1,
      status: "skipped",
      at: 5,
    });
    expect(getProjectWelcome(PROJECT_B, OWNER, "welcome")).toBeNull();
    expect(getProjectWelcome(PROJECT_A, "other.plugin", "welcome")).toBeNull();
    expect(getProjectWelcome(PROJECT_A, OWNER, "tour-2")).toBeNull();

    setProjectWelcome(PROJECT_A, OWNER, "welcome", 2, "completed", 6);
    expect(getProjectWelcome(PROJECT_A, OWNER, "welcome")?.version).toBe(2);
  });

  it("keeps an answer made under a higher revision when an older plugin writes", () => {
    setProjectWelcome(PROJECT_A, OWNER, "welcome", 3, "completed", 1);
    expect(setProjectWelcome(PROJECT_A, OWNER, "welcome", 2, "skipped", 2)).toEqual({
      version: 3,
      status: "completed",
      at: 1,
    });
    expect(storeMock.set).toHaveBeenCalledTimes(1);
  });

  it("keeps other projects and plugins when writing one", () => {
    setProjectWelcome(PROJECT_B, OWNER, "welcome", 1, "skipped", 1);
    setProjectWelcome(PROJECT_A, "other.plugin", "welcome", 1, "completed", 2);
    setProjectWelcome(PROJECT_A, OWNER, "welcome", 1, "completed", 3);
    expect(getProjectWelcome(PROJECT_B, OWNER, "welcome")?.status).toBe("skipped");
    expect(getProjectWelcome(PROJECT_A, "other.plugin", "welcome")?.at).toBe(2);
  });

  it("reads a malformed entry as no answer", () => {
    storeMock.data.set("projectApplicationWelcomes", {
      [PROJECT_A]: { [OWNER]: { welcome: { version: 0, status: "completed" } } },
      [PROJECT_B]: { [OWNER]: { welcome: { version: 1, status: "bogus" } } },
    });
    expect(getProjectWelcome(PROJECT_A, OWNER, "welcome")).toBeNull();
    expect(getProjectWelcome(PROJECT_B, OWNER, "welcome")).toBeNull();
  });

  it("refuses malformed keys and values", () => {
    expect(() => getProjectWelcome("scratch-1", OWNER, "welcome")).toThrow(/project workspace id/);
    expect(() => setProjectWelcome(PROJECT_A, "", "welcome", 1, "skipped")).toThrow(/plugin id/);
    expect(() => setProjectWelcome(PROJECT_A, OWNER, "", 1, "skipped")).toThrow(/tour id/);
    expect(() => setProjectWelcome(PROJECT_A, OWNER, "welcome", 1.5, "skipped")).toThrow(
      /positive integer/
    );
    expect(() =>
      setProjectWelcome(PROJECT_A, OWNER, "welcome", 1, "started" as unknown as "skipped")
    ).toThrow(/unknown status/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});
