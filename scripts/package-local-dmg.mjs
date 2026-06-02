#!/usr/bin/env node
// Builds an unsigned local Mac build for testing, stamped with a dev version one
// minor above the current package.json version (e.g. 0.16.0 -> 0.17.0-dev).
// Defaults to a .dmg; pass --dir for an unpackaged .app directory instead.
// The bump is applied via electron-builder's extraMetadata override only —
// package.json on disk is never modified.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync as read } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(read(join(root, "package.json"), "utf8"));

const [major, minor] = version.split("-")[0].split(".").map(Number);
const devVersion = `${major}.${minor + 1}.0-dev`;

const passthrough = process.argv.slice(2);
const dirIdx = passthrough.indexOf("--dir");
const isDir = dirIdx !== -1;
if (isDir) passthrough.splice(dirIdx, 1);
const target = isDir ? "--dir" : "dmg";

console.log(
  `Packaging local ${isDir ? "app dir" : "dmg"} as v${devVersion} (working tree stays v${version})`
);

const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });

run("npm", ["run", "build"]);
run("npx", [
  "electron-builder",
  "--mac",
  target,
  "-c.mac.identity=null",
  "-c.mac.forceCodeSigning=false",
  "-c.mac.notarize=false",
  `-c.extraMetadata.version=${devVersion}`,
  ...passthrough,
]);
