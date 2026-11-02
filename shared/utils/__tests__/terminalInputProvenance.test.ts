import { describe, expect, it } from "vitest";
import {
  foreignInputMoved,
  foreignTypedInputAt,
  stampTypedInput,
  typedSinceSettle,
  type TypedInputProvenance,
} from "../terminalInputProvenance.js";

const A = "principal-a";
const B = "principal-b";

/** A record written by `writes` in order, one per millisecond from 1. */
function written(writes: ReadonlyArray<string | undefined>): TypedInputProvenance {
  const record: TypedInputProvenance = {};
  writes.forEach((owner, index) => stampTypedInput(record, index + 1, owner));
  return record;
}

/** The newest write by anyone but `owner`, read straight off the history. */
function newestForeign(writes: ReadonlyArray<string | undefined>, owner: string) {
  let at: number | undefined;
  writes.forEach((writer, index) => {
    if (writer !== owner) at = index + 1;
  });
  return at;
}

describe("typed-input provenance (#16094)", () => {
  it("keeps an assistant's keys its own and everyone else's foreign", () => {
    const record = written([A, A]);
    expect(foreignTypedInputAt(record, A)).toBeUndefined();
    expect(foreignTypedInputAt(record, B)).toBe(2);
  });

  it("never files a person's key under the assistant that writes after it", () => {
    const record = written([A, undefined, A]);
    expect(foreignTypedInputAt(record, A)).toBe(2);
  });

  it("answers exactly for every caller however two assistants and a person interleave", () => {
    const writers = [A, B, undefined] as const;
    // Every history of up to five writes.
    const histories: Array<Array<string | undefined>> = [[]];
    for (let length = 0; length < 5; length += 1) {
      for (const history of histories.filter((h) => h.length === length)) {
        for (const writer of writers) histories.push([...history, writer]);
      }
    }
    for (const history of histories) {
      const record = written(history);
      for (const owner of [A, B]) {
        expect(foreignTypedInputAt(record, owner), JSON.stringify(history)).toBe(
          newestForeign(history, owner)
        );
      }
    }
  });

  it("counts every typed input as someone's on a record with no provenance", () => {
    expect(foreignTypedInputAt({ lastTypedInputAt: 7 }, A)).toBe(7);
    expect(typedSinceSettle({ lastTypedInputAt: 7, lastStateChange: 5 }, A)).toBe("someone");
  });

  it("tells nothing, own keys and someone's input since the settle apart", () => {
    const own = { ...written([undefined, A]), lastStateChange: 2 };
    expect(typedSinceSettle(own, A)).toBe("own-keys");
    expect(typedSinceSettle(own, B)).toBe("someone");
    expect(typedSinceSettle({ ...written([A]), lastStateChange: 2 }, A)).toBe("nothing");
    expect(typedSinceSettle({ ...written([A, undefined]), lastStateChange: 1 }, A)).toBe("someone");
  });

  it("counts everything ever typed as since the settle when none was seen", () => {
    expect(typedSinceSettle(written([undefined]), A)).toBe("someone");
    expect(typedSinceSettle(written([A]), A)).toBe("own-keys");
    expect(typedSinceSettle({}, A)).toBe("nothing");
  });

  it("sees someone else's input arrive after a reading, never its own", () => {
    const record = written([undefined, A]);
    const before = foreignTypedInputAt(record, A);
    stampTypedInput(record, 3, A);
    expect(foreignInputMoved(record, A, before)).toBe(false);
    stampTypedInput(record, 4);
    expect(foreignInputMoved(record, A, before)).toBe(true);
    expect(foreignInputMoved(written([A]), A, undefined)).toBe(false);
    expect(foreignInputMoved(written([B]), A, undefined)).toBe(true);
  });
});
