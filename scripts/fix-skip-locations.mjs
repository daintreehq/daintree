#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const FIXES = [
  {
    file: "e2e/full/resilience/core-process-cleanup.spec.ts",
    operations: [
      {
        old: `test.info().annotations.push({
  type: "platform-skip",
  description: "Process cleanup tests are Unix-only",
});

test.skip(process.platform === "win32", "Process cleanup tests are Unix-only");

`,
        new: "",
      },
      {
        old: 'test.describe("Core: Process Cleanup", () => {\n  test("clean exit kills PTY process tree", async () => {',
        new: 'test.describe("Core: Process Cleanup", () => {\n  test.beforeAll(() => {\n    test.info().annotations.push({\n      type: "platform-skip",\n      description: "Process cleanup tests are Unix-only",\n    });\n    test.skip(process.platform === "win32", "Process cleanup tests are Unix-only");\n  });\n\n  test("clean exit kills PTY process tree", async () => {',
      },
    ],
  },
  {
    file: "e2e/full/panels/core-portal.spec.ts",
    operations: [
      {
        old: `test.describe.serial("Core: Portal Multi-Tab Lifecycle", () => {
  test.info().annotations.push({
    type: "platform-skip",
    description: "Windows CI: portal not supported with GPU disabled",
  });

  test.skip(
    process.platform === "win32" && !!process.env.CI,
    "Windows CI: portal not supported with GPU disabled"
  );

  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {`,
        new: `test.describe.serial("Core: Portal Multi-Tab Lifecycle", () => {
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Windows CI: portal not supported with GPU disabled",
    });
    test.skip(
      process.platform === "win32" && !!process.env.CI,
      "Windows CI: portal not supported with GPU disabled"
    );
`,
      },
    ],
  },
  {
    file: "e2e/full/panels/core-browser-panel.spec.ts",
    operations: [
      {
        old: `  test.describe.serial("Find in Page", () => {
    test.info().annotations.push({
      type: "quarantine",
      description: "2026-05-27 webview instability causes Electron crash in E2E sequence",
    });

    test.skip(() => true, "webview instability causes Electron crash in E2E sequence");`,
        new: `  test.describe.serial("Find in Page", () => {
    test.beforeAll(() => {
      test.info().annotations.push({
        type: "quarantine",
        description: "2026-05-27 webview instability causes Electron crash in E2E sequence",
      });
      test.skip(() => true, "webview instability causes Electron crash in E2E sequence");
    });`,
      },
    ],
  },
];

for (const fix of FIXES) {
  const filePath = join(root, fix.file);
  let content = readFileSync(filePath, "utf8");
  let changed = false;

  for (const op of fix.operations) {
    if (content.includes(op.old)) {
      content = content.replace(op.old, op.new);
      changed = true;
    } else {
      console.log(`  WARNING: pattern not found in ${fix.file}`);
    }
  }

  if (changed) {
    writeFileSync(filePath, content, "utf8");
    console.log(`✓ ${fix.file}: fixed`);
  } else {
    console.log(`- ${fix.file}: no changes needed`);
  }
}
