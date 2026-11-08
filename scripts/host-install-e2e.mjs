#!/usr/bin/env node
// The host install end to end (electron/remote/__tests__/hostInstall.container.e2e.test.ts):
// runs it against DAINTREE_CONTAINER_E2E_APPIMAGE, or against the current commit
// packaged in a container. Native modules link against what they're built on, so
// a Linux build can't come from another OS, and a worktree's node_modules is
// shared with its main checkout, so nothing here installs in place.
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = "electron/remote/__tests__/hostInstall.container.e2e.test.ts";

function text(file, args) {
  return execFileSync(file, args, { cwd: root, encoding: "utf8" }).trim();
}

/** Where electron-builder puts the AppImage: x64's name carries no arch. */
function appImageFileName(version, arch) {
  return arch === "x64" ? `Daintree-${version}.AppImage` : `Daintree-${version}-${arch}.AppImage`;
}

/**
 * Builds a packaged AppImage from the tree on stdin and writes it to stdout;
 * everything the build prints goes to stderr.
 */
function packageScript(nodeArch, name) {
  return [
    "set -eux",
    "exec 3>&1 1>&2",
    "mkdir /src",
    "tar -x -C /src",
    "cd /src",
    // What release-linux.yml installs for its native modules and packaging.
    "apt-get update",
    "apt-get install -y --no-install-recommends libarchive-tools libxss-dev libsecret-1-dev libnss3-dev libnotify-dev libxkbfile-dev",
    "npm ci",
    "npm run build",
    `npx electron-builder --config electron-builder.config.cjs --linux AppImage --${nodeArch} --publish never`,
    `cat "release/${name}" >&3`,
  ].join("\n");
}

function packageCurrentCommit() {
  const commit = text("git", ["rev-parse", "HEAD"]);
  // From the commit that gets packaged, not the working tree.
  const atCommit = (file) => text("git", ["show", `${commit}:${file}`]);
  const { version } = JSON.parse(atCommit("package.json"));
  const nodeVersion = atCommit(".nvmrc");
  const serverArch = text("docker", ["version", "--format", "{{.Server.Arch}}"]);
  const arch = serverArch === "arm64" || serverArch === "aarch64" ? "arm64" : "x64";
  const name = appImageFileName(version, arch);
  const outDir = path.join(root, ".tmp", "host-install-e2e", commit);
  const out = path.join(outDir, name);
  if (existsSync(out)) {
    process.stdout.write(`Using ${path.relative(root, out)}\n`);
    return out;
  }
  if (text("git", ["status", "--porcelain"]) !== "") {
    process.stdout.write(`Packaging commit ${commit}: uncommitted changes aren't in it.\n`);
  }
  mkdirSync(outDir, { recursive: true });
  const tree = path.join(outDir, `tree-${process.pid}.tar`);
  const partial = `${out}.${process.pid}.part`;
  execFileSync("git", ["archive", "--format=tar", "--output", tree, commit], { cwd: root });
  const input = openSync(tree, "r");
  const output = openSync(partial, "w", 0o755);
  try {
    const packaging = spawnSync(
      "docker",
      [
        "run",
        "--interactive",
        // Nothing to clean up after, whatever becomes of this process; the build
        // comes back over stdout and lands under its real name only once whole.
        "--rm",
        // No .git in there, so build-main can't read the commit it stamps.
        "--env",
        `DAINTREE_BUILD_COMMIT=${commit}`,
        "--env",
        "NODE_OPTIONS=--max-old-space-size=6144",
        `node:${nodeVersion}-bookworm`,
        "timeout",
        "--signal=KILL",
        "7200",
        "bash",
        "-c",
        packageScript(arch, name),
      ],
      { stdio: [input, output, "inherit"] }
    );
    if (packaging.error) throw packaging.error;
    if (packaging.status !== 0) {
      throw new Error(`Packaging in a container failed with exit code ${packaging.status}`);
    }
    renameSync(partial, out);
  } finally {
    closeSync(input);
    closeSync(output);
    rmSync(tree, { force: true });
    rmSync(partial, { force: true });
  }
  return out;
}

try {
  const appImage = process.env.DAINTREE_CONTAINER_E2E_APPIMAGE || packageCurrentCommit();
  const run = spawnSync("npx", ["vitest", "run", SUITE], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      DAINTREE_CONTAINER_E2E: "1",
      DAINTREE_CONTAINER_E2E_APPIMAGE: path.resolve(appImage),
    },
  });
  process.exit(run.status ?? 1);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
