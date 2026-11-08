#!/usr/bin/env node
// The host install end to end (electron/remote/__tests__/hostInstall.container.e2e.test.ts):
// runs it against DAINTREE_CONTAINER_E2E_APPIMAGE, or against the current commit
// packaged in a container. Native modules link against what they're built on, so
// a Linux build can't come from another OS, and a worktree's node_modules is
// shared with its main checkout, so nothing here installs in place.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
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

/** The script that builds a packaged AppImage from the tree on its stdin. */
function packageScript(nodeArch) {
  return [
    "set -eux",
    "mkdir /src",
    "tar -x -C /src",
    "cd /src",
    // What release-linux.yml installs for its native modules and packaging.
    "apt-get update",
    "apt-get install -y --no-install-recommends libarchive-tools libxss-dev libsecret-1-dev libnss3-dev libnotify-dev libxkbfile-dev",
    "npm ci",
    "npm run build",
    `npx electron-builder --config electron-builder.config.cjs --linux AppImage --${nodeArch} --publish never`,
  ].join("\n");
}

async function packageCurrentCommit() {
  const commit = text("git", ["rev-parse", "HEAD"]);
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
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
  const nodeVersion = readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
  const container = `daintree-host-install-package-${process.pid}`;
  const archive = spawn("git", ["archive", "--format=tar", "HEAD"], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const packaging = spawn(
    "docker",
    [
      "run",
      "--interactive",
      "--name",
      container,
      // No .git in there, so build-main can't read the commit it stamps.
      "--env",
      `DAINTREE_BUILD_COMMIT=${commit}`,
      "--env",
      "NODE_OPTIONS=--max-old-space-size=6144",
      `node:${nodeVersion}-bookworm`,
      "bash",
      "-c",
      packageScript(arch),
    ],
    { stdio: ["pipe", "inherit", "inherit"] }
  );
  archive.stdout.pipe(packaging.stdin);
  try {
    const code = await new Promise((resolve, reject) => {
      packaging.once("error", reject);
      packaging.once("exit", resolve);
    });
    if (code !== 0) throw new Error(`Packaging in a container failed with exit code ${code}`);
    execFileSync("docker", ["cp", `${container}:/src/release/${name}`, out], { stdio: "inherit" });
  } finally {
    spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
  return out;
}

try {
  const appImage = process.env.DAINTREE_CONTAINER_E2E_APPIMAGE || (await packageCurrentCommit());
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
