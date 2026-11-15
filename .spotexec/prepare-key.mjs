// Prints a hash of everything `npm run prepare --workspaces` could read. The
// package builds pull in shared/, src/, electron/ and scripts/ as well as
// packages/, so this covers every file git sees (tracked or untracked, not
// ignored) except tests: editing a test reuses the slot's package builds,
// editing anything else rebuilds them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import process from "node:process";

const listed = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    maxBuffer: 1 << 28,
  }
);
const files = [...new Set(listed.toString().split("\0").filter(Boolean))].sort();
const isTest = (f) =>
  /(^|\/)(__tests__|__mocks__)\//.test(f) ||
  /^e2e\//.test(f) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);

const hash = createHash("sha1");
for (const file of files) {
  if (isTest(file)) continue;
  hash.update(file).update("\0");
  let stat;
  try {
    stat = lstatSync(file);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    hash.update("deleted\0");
    continue;
  }
  const data = stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file);
  hash.update(String(data.length)).update("\0").update(data);
}
process.stdout.write(`${hash.digest("hex")}\n`);
