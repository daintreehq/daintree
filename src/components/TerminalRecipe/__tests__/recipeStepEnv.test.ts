import { describe, it, expect } from "vitest";
import {
  draftsToEnv,
  envToDrafts,
  serializeEnvDrafts,
  validateRecipeEnvRows,
} from "../recipeStepEnv";

const row = (id: string, key: string, value = "") => ({ id, key, value });

describe("recipeStepEnv", () => {
  it("round-trips a step's env through rows, each with its own id", () => {
    const env = { PORT: "3000", EMPTY: "" };
    const rows = envToDrafts(env);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(draftsToEnv(rows)).toEqual(env);
    expect(envToDrafts(undefined)).toEqual([]);
  });

  it("saves trimmed names, drops nameless rows and keeps values exactly", () => {
    expect(
      draftsToEnv([row("a", "  PORT ", " 3000 "), row("b", "", "orphan"), row("c", "EMPTY")])
    ).toEqual({ PORT: " 3000 ", EMPTY: "" });
  });

  it("flags bad and repeated names, and a control character only in a named row's value", () => {
    const errors = validateRecipeEnvRows([
      row("bad", "1X"),
      row("first", "X", "a\tb"),
      row("dup", "X"),
      row("nameless", "", "a\tb"),
      row("ok", "Y", "fine"),
    ]);
    expect(Object.keys(errors).sort()).toEqual(["bad", "dup", "first"]);
    expect([errors.bad?.field, errors.dup?.field, errors.first?.field]).toEqual([
      "key",
      "key",
      "value",
    ]);
    expect(errors.first?.message).not.toBe(errors.dup?.message);
  });

  it("saves a name that is also an Object.prototype key as the variable it is", () => {
    const env = draftsToEnv([row("p", "__proto__", "x"), row("c", "constructor", "y")]);
    expect(Object.hasOwn(env, "__proto__")).toBe(true);
    expect(Object.entries(env)).toEqual([
      ["__proto__", "x"],
      ["constructor", "y"],
    ]);
  });

  it("compares rows by content, not order, counting invalid ones and ignoring blank ones", () => {
    const a = serializeEnvDrafts([row("1", "B", "2"), row("2", "A", "1"), row("3", "")]);
    const b = serializeEnvDrafts([row("x", "A", "1"), row("y", " B ", "2")]);
    expect(a).toEqual(b);
    expect(serializeEnvDrafts([row("1", "1BAD")])).not.toEqual(serializeEnvDrafts([]));
    expect(serializeEnvDrafts([row("1", "", "value")])).not.toEqual(serializeEnvDrafts([]));
  });
});
