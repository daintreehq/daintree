#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = JSON.parse(readFileSync(resolve(repoRoot, "package-lock.json"), "utf-8"));
const version = lockfile.packages?.["node_modules/electron"]?.version;

if (!version || typeof version !== "string" || !version.trim()) {
  console.error("resolve-electron-version: electron version not found in package-lock.json");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version.trim())) {
  console.error(`resolve-electron-version: unexpected version format: "${version.trim()}"`);
  process.exit(1);
}

process.stdout.write(version.trim());
