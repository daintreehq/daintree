import { GIT_BLOCK_TIMEOUT_MS } from "../../utils/hardenedGit.js";
import { runGitForBytes } from "./reviewPoint/runGit.js";

/**
 * Blob reads by object id through one `git cat-file` each, however many blobs
 * are asked for. The ids go in on stdin, so no path is ever parsed as an
 * argument or split on a newline, and an id names exactly the object it was
 * listed with.
 */

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// `<oid> blob <size>\n` and the newline after the content.
const HEADER_SLACK_BYTES = 32;

function checkedUnique(oids: Iterable<string>): string[] {
  const unique = [...new Set(oids)];
  for (const oid of unique) {
    if (!OID_RE.test(oid)) throw new Error(`Invalid object id: ${oid}`);
  }
  return unique;
}

function stdinFor(oids: readonly string[]): Buffer {
  return Buffer.from(oids.map((oid) => `${oid}\n`).join(""), "utf8");
}

/**
 * The size of each blob, from `--batch-check`. Rejects when any id is missing
 * or not a blob, since a blob that can't be sized can't be shown to be safe to
 * skip either.
 */
export async function readBlobSizes(
  cwd: string,
  oids: Iterable<string>
): Promise<Map<string, number>> {
  const unique = checkedUnique(oids);
  if (unique.length === 0) return new Map();
  const { stdout } = await runGitForBytes(cwd, ["cat-file", "--batch-check", "--buffer"], {
    input: stdinFor(unique),
    timeoutMs: GIT_BLOCK_TIMEOUT_MS,
    maxStdoutBytes: unique.length * (64 + HEADER_SLACK_BYTES),
  });
  const lines = stdout.toString("utf8").split("\n");
  const sizes = new Map<string, number>();
  unique.forEach((oid, i) => {
    const line = lines[i] ?? "";
    const [name, type, size] = line.split(" ");
    if (name !== oid || type !== "blob" || !/^\d+$/.test(size ?? "")) {
      throw new Error(`git cat-file could not size blob ${oid}: ${line || "no answer"}`);
    }
    sizes.set(oid, Number(size));
  });
  return sizes;
}

/**
 * The content of each blob, from `--batch`, given the sizes `readBlobSizes`
 * reported: they bound the output before git starts, and each answer has to
 * match its own.
 */
export async function readBlobs(
  cwd: string,
  sizes: ReadonlyMap<string, number>
): Promise<Map<string, Buffer>> {
  const oids = checkedUnique(sizes.keys());
  if (oids.length === 0) return new Map();
  let expectedBytes = 0;
  for (const oid of oids) expectedBytes += sizes.get(oid)! + oid.length + HEADER_SLACK_BYTES;
  const { stdout } = await runGitForBytes(cwd, ["cat-file", "--batch", "--buffer"], {
    input: stdinFor(oids),
    timeoutMs: GIT_BLOCK_TIMEOUT_MS,
    maxStdoutBytes: expectedBytes,
  });

  const contents = new Map<string, Buffer>();
  let pos = 0;
  for (const oid of oids) {
    const size = sizes.get(oid)!;
    const eol = stdout.indexOf(0x0a, pos);
    const header = eol === -1 ? "" : stdout.toString("utf8", pos, eol);
    if (header !== `${oid} blob ${size}`) {
      throw new Error(`git cat-file could not read blob ${oid}: ${header || "no answer"}`);
    }
    const start = eol + 1;
    const end = start + size;
    if (end >= stdout.length || stdout[end] !== 0x0a) {
      throw new Error(`git cat-file cut blob ${oid} short`);
    }
    contents.set(oid, stdout.subarray(start, end));
    pos = end + 1;
  }
  return contents;
}
