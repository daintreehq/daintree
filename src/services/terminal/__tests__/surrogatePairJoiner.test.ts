import { describe, expect, it } from "vitest";
import { createSurrogatePairJoiner } from "../inputUtils";

const EMOJI = "\u{1F642}";
const HIGH = EMOJI[0]!;
const LOW = EMOJI[1]!;

describe("createSurrogatePairJoiner", () => {
  it("rejoins an emoji xterm emitted one UTF-16 unit per event", () => {
    const { join } = createSurrogatePairJoiner();
    expect(join("a")).toEqual(["a"]);
    expect(join(HIGH)).toEqual([]);
    expect(join(LOW)).toEqual([EMOJI]);
    expect(join("b")).toEqual(["b"]);
  });

  it("passes whole pairs and plain text through untouched", () => {
    const { join } = createSurrogatePairJoiner();
    expect(join(`x${EMOJI}y`)).toEqual([`x${EMOJI}y`]);
    expect(join("\x1b[A")).toEqual(["\x1b[A"]);
  });

  it("holds only the trailing high surrogate of a longer chunk", () => {
    const { join } = createSurrogatePairJoiner();
    expect(join(`ab${HIGH}`)).toEqual(["ab"]);
    expect(join(`${LOW}c`)).toEqual([`${EMOJI}c`]);
  });

  it("releases an orphaned high surrogate on its own before unrelated input", () => {
    const { join } = createSurrogatePairJoiner();
    join(HIGH);
    expect(join("\x1b[I")).toEqual([HIGH, "\x1b[I"]);
    expect(join("z")).toEqual(["z"]);
  });

  it("chains a held half into the next held half", () => {
    const { join } = createSurrogatePairJoiner();
    join(HIGH);
    expect(join(HIGH)).toEqual([HIGH]);
    expect(join(LOW)).toEqual([EMOJI]);
  });

  it("forgets a held half once reset", () => {
    const joiner = createSurrogatePairJoiner();
    joiner.join(HIGH);
    joiner.reset();
    expect(joiner.join("x")).toEqual(["x"]);
    expect(joiner.join(LOW)).toEqual([LOW]);
  });
});
