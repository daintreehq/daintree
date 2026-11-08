import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Turns a packaged AppImage into a second build: the same bytes running, with a
// build marker that names another commit. Staging reads only the marker, so it
// passes; the running process reports the commit compiled into it, so the check
// after the restart doesn't.
const [input, output, commit] = process.argv.slice(2);
const work = path.dirname(output);
const run = (file, args) =>
  execFileSync(file, args, { cwd: work, stdio: ["ignore", "pipe", "inherit"] });

execFileSync("chmod", ["755", input]);
const offset = Number(run(input, ["--appimage-offset"]).toString().trim());
run(input, ["--appimage-extract"]);

// Asar stores files as they are, so the marker is patched in place. Only a
// commit of the same length keeps the archive's offsets right.
const asarPath = path.join(work, "squashfs-root/resources/app.asar");
const asar = readFileSync(asarPath);
const text = asar.toString("latin1");
const match = /\{"daintreeBuildInfo":1,"version":"[^"]+","commit":"([0-9a-f]+)"\}/.exec(text);
if (!match) throw new Error("No build marker in the AppImage");
if (match[1].length !== commit.length) throw new Error("The new commit must be the same length");
const at = match.index + match[0].length - 2 - commit.length;
asar.write(commit, at, "latin1");
writeFileSync(asarPath, asar);

const image = path.join(work, "image.squashfs");
run("mksquashfs", ["squashfs-root", image, "-root-owned", "-noappend", "-comp", "zstd", "-quiet"]);
const out = openSync(output, "w", 0o755);
writeSync(out, readFileSync(input).subarray(0, offset));
writeSync(out, readFileSync(image));
closeSync(out);
