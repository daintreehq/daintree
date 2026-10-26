import { describe, expect, it } from "vitest";
import {
  parseConfigListing,
  parseDiffTreeRaw,
  parseIndexListing,
  parsePorcelainV2,
} from "../parseGitRecords.js";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const ZERO = "0".repeat(40);

function z(...records: Array<string | Buffer>): Buffer {
  return Buffer.concat(records.flatMap((r) => [Buffer.from(r), Buffer.from([0])]));
}

describe("parsePorcelainV2", () => {
  it("reads the branch headers and every record kind, keeping path bytes", () => {
    const raw = Buffer.concat([
      Buffer.from("1 .M N... 100644 100644 100644 "),
      Buffer.from(`${OID_A} ${OID_A} `),
      Buffer.from([0x62, 0xff]),
    ]);
    const parsed = parsePorcelainV2(
      z(
        `# branch.oid ${OID_A}`,
        "# branch.head topic",
        "# stash 2",
        `1 M. N... 100644 100644 100644 ${OID_A} ${OID_B} name with spaces.txt`,
        raw,
        `u UU N... 100644 100644 100644 100644 ${OID_A} ${OID_B} ${OID_A} c.txt`,
        `u DU N... 100644 000000 100644 100644 ${OID_A} ${ZERO} ${OID_B} d.txt`,
        "? new dir/file"
      )
    );
    expect(parsed.headOid).toBe(OID_A);
    expect(parsed.headBranch).toBe("topic");
    expect(parsed.records.map((r) => r.kind)).toEqual([
      "changed",
      "changed",
      "unmerged",
      "unmerged",
      "untracked",
    ]);
    expect(parsed.records[0]).toMatchObject({ xy: "M.", oidIndex: OID_B });
    expect(parsed.records[0].path.toString()).toBe("name with spaces.txt");
    expect(parsed.records[1].path.equals(Buffer.from([0x62, 0xff]))).toBe(true);
    expect(parsed.records[3]).toMatchObject({
      stages: [
        { stage: 1, mode: "100644", oid: OID_A },
        { stage: 3, mode: "100644", oid: OID_B },
      ],
    });
    expect(parsed.records[4].path.toString()).toBe("new dir/file");
  });

  it("reads an unborn, detached-free HEAD and a detached one", () => {
    expect(parsePorcelainV2(z("# branch.oid (initial)", "# branch.head main"))).toMatchObject({
      headOid: null,
      headBranch: "main",
    });
    expect(parsePorcelainV2(z(`# branch.oid ${OID_A}`, "# branch.head (detached)"))).toMatchObject({
      headOid: OID_A,
      headBranch: null,
    });
  });

  it("refuses output it doesn't recognise rather than skip a path", () => {
    const headers = [`# branch.oid ${OID_A}`, "# branch.head x"];
    const rename = `2 R. N... 100644 100644 100644 ${OID_A} ${OID_B} R100 new`;
    expect(() => parsePorcelainV2(z(...headers, rename, "old"))).toThrow("Unrecognised");
    expect(() => parsePorcelainV2(z(...headers, "1 M. N... 100644"))).toThrow("Malformed");
    expect(() =>
      parsePorcelainV2(z(...headers, `1 M. N... 100644 100644 100644 ${OID_A} nope a.txt`))
    ).toThrow("Malformed");
    expect(() => parsePorcelainV2(z("# branch.head x", "? orphan"))).toThrow("branch headers");
    expect(() => parsePorcelainV2(z(`# branch.oid ${OID_A}`, "? orphan"))).toThrow(
      "branch headers"
    );
  });

  it("refuses output that stops before its last NUL", () => {
    const whole = z(`# branch.oid ${OID_A}`, "# branch.head x", "? a.txt");
    expect(() => parsePorcelainV2(whole.subarray(0, whole.length - 1))).toThrow("Truncated");
  });
});

describe("parseDiffTreeRaw", () => {
  it("reads one path per record", () => {
    const records = parseDiffTreeRaw(
      z(
        `:100644 100755 ${OID_A} ${OID_B} M`,
        "a b.txt",
        `:000000 120000 ${ZERO} ${OID_A} A`,
        "link"
      )
    );
    expect(records).toEqual([
      {
        srcMode: "100644",
        dstMode: "100755",
        srcOid: OID_A,
        dstOid: OID_B,
        status: "M",
        path: Buffer.from("a b.txt"),
      },
      {
        srcMode: "000000",
        dstMode: "120000",
        srcOid: ZERO,
        dstOid: OID_A,
        status: "A",
        path: Buffer.from("link"),
      },
    ]);
  });

  it("refuses renames and records missing their path", () => {
    expect(() =>
      parseDiffTreeRaw(z(`:100644 100644 ${OID_A} ${OID_B} R100`, "old", "new"))
    ).toThrow("Malformed");
    expect(() => parseDiffTreeRaw(z(`:100644 100644 ${OID_A} ${OID_B} M`))).toThrow("Malformed");
    expect(() => parseDiffTreeRaw(z(`:100644 100644 ${OID_A} short M`, "a"))).toThrow("Malformed");
  });

  it("reads diff-index's unmerged records", () => {
    expect(parseDiffTreeRaw(z(`:100644 000000 ${OID_A} ${ZERO} U`, "c"))[0]).toMatchObject({
      srcOid: OID_A,
      status: "U",
    });
  });
});

describe("parseIndexListing", () => {
  it("reads the tag, stage and path", () => {
    expect(parseIndexListing(z(`h 100644 ${OID_A} 0\ta\tb`, `M 100644 ${OID_B} 2\tc`))).toEqual([
      { tag: "h", mode: "100644", oid: OID_A, stage: 0, path: Buffer.from("a\tb") },
      { tag: "M", mode: "100644", oid: OID_B, stage: 2, path: Buffer.from("c") },
    ]);
    expect(() => parseIndexListing(z("H 100644"))).toThrow();
  });
});

describe("parseConfigListing", () => {
  it("reads values, including empty and missing ones, keeping key bytes", () => {
    const odd = Buffer.concat([
      Buffer.from("filter.b"),
      Buffer.from([0xff]),
      Buffer.from(".clean"),
    ]);
    const entries = parseConfigListing(
      z(
        "filter.My.Driver.clean\ncat",
        "core.filemode\n",
        "core.symlinks",
        Buffer.concat([odd, Buffer.from("\nx")])
      )
    );
    expect(entries.map(({ key, value }) => [key.toString("utf8"), value])).toEqual([
      ["filter.My.Driver.clean", "cat"],
      ["core.filemode", ""],
      ["core.symlinks", null],
      [odd.toString("utf8"), "x"],
    ]);
    expect(entries[3].key.equals(odd)).toBe(true);
  });
});
