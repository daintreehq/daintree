import { bench, describe, vi } from "vitest";

// validateIpcInvokeEnvelope runs on every ipcMain.handle invoke before the
// listener. Payload shapes mirror real traffic: small request objects, file
// saves and diffs carrying source text, and list-shaped arguments.
//
//   npx vitest bench --run electron/setup/__bench__/ipcEnvelope.bench.ts

vi.mock("electron", () => ({ app: { isPackaged: false, on: () => {} }, ipcMain: {}, session: {} }));
vi.mock("../../services/TelemetryService.js", () => ({ getCurrentCorrelationId: () => undefined }));

import {
  DEFAULT_PAYLOAD_BUDGET,
  isProvablyWithinPayloadBudget,
  PAYLOAD_BUDGETS,
  validateIpcInvokeEnvelope,
} from "../security.js";
import { channelToCategory } from "../../ipc/utils.js";

const SOURCE_LINE = [
  'import { useCallback } from "react";',
  "export function formatLabel(value: string, width = 80): string {",
  '  const trimmed = value.replace(/\\s+/g, " ").trim(); // collapse — naïve',
  "\treturn trimmed.length > width ? `${trimmed.slice(0, width - 1)}…` : trimmed;",
  "}",
  "",
].join("\n");

function sourceText(chars: number): string {
  return SOURCE_LINE.repeat(Math.ceil(chars / SOURCE_LINE.length)).slice(0, chars);
}

const small: unknown[] = [
  {
    worktreeId: "wt-7f3c2a",
    path: "/Users/dev/projects/app/src/index.ts",
    recursive: true,
    limit: 50,
  },
];
const terminalSpawn: unknown[] = [
  {
    id: "term-4b1e",
    cwd: "/Users/dev/projects/app",
    cols: 120,
    rows: 40,
    kind: "terminal",
    launchAgentId: "claude",
    command: "claude",
    env: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`VAR_${i}`, `/opt/tool-${i}/bin:/usr/local/bin`])
    ),
  },
];
const nested: unknown[] = [
  {
    projectId: "project-1",
    items: Array.from({ length: 500 }, (_, i) => ({
      id: `panel-${i}`,
      kind: i % 3 === 0 ? "terminal" : "browser",
      title: `Panel ${i}`,
      location: "grid",
      bounds: [i, i * 2, 640, 480],
      tags: ["a", "b", "c"],
      pinned: i % 7 === 0,
    })),
  },
];
const save10k: unknown[] = [
  { path: "/Users/dev/projects/app/src/a.ts", content: sourceText(10 * 1024) },
];
const save100k: unknown[] = [
  { path: "/Users/dev/projects/app/src/b.ts", content: sourceText(100 * 1024) },
];
const save1m: unknown[] = [
  { path: "/Users/dev/projects/app/src/c.ts", content: sourceText(1024 * 1024) },
];
// Worst cases for the fast path: it pays its scan and still has to fall back.
const save1mTrailingControl: unknown[] = [
  { path: "/Users/dev/projects/app/src/d.ts", content: sourceText(1024 * 1024 - 1) + "\u0001" },
];
const nestedWithDate: unknown[] = [{ ...(nested[0] as object), updatedAt: new Date(0) }];

// Illustrative weighting (not measured traffic): mostly small requests, some
// list-shaped and spawn payloads, occasional file-sized strings. Channel names
// are real, so each case runs against the budget it gets in production.
const MIX: Array<[string, unknown[]]> = [
  ...Array.from({ length: 70 }, (): [string, unknown[]] => ["files:read", small]),
  ...Array.from({ length: 10 }, (): [string, unknown[]] => ["app:set-state", nested]),
  ...Array.from({ length: 5 }, (): [string, unknown[]] => ["terminal:spawn", terminalSpawn]),
  ...Array.from({ length: 10 }, (): [string, unknown[]] => ["clipboard:write-text", save10k]),
  ...Array.from({ length: 4 }, (): [string, unknown[]] => ["clipboard:write-text", save100k]),
  ["artifact:save-to-file", save1m],
];

const conclusive = MIX.filter(([channel, args]) => {
  const category = channelToCategory[channel];
  return isProvablyWithinPayloadBudget(
    args,
    category !== undefined ? PAYLOAD_BUDGETS[category] : DEFAULT_PAYLOAD_BUDGET
  );
}).length;
process.stderr.write(
  `fast path conclusive for ${conclusive}/${MIX.length} invokes in the weighted mix\n`
);

describe("validateIpcInvokeEnvelope", () => {
  bench("small object", () => validateIpcInvokeEnvelope("files:read", small));
  bench("terminal:spawn env (40 vars)", () =>
    validateIpcInvokeEnvelope("terminal:spawn", terminalSpawn)
  );
  bench("nested array (500 objects)", () => validateIpcInvokeEnvelope("app:set-state", nested));
  bench("10 KB source string", () => validateIpcInvokeEnvelope("clipboard:write-text", save10k));
  bench("100 KB source string", () => validateIpcInvokeEnvelope("clipboard:write-text", save100k));
  bench("1 MB source string (artifactOps)", () =>
    validateIpcInvokeEnvelope("artifact:save-to-file", save1m)
  );
  bench("worst case: 1 MB string, control char at the end", () =>
    validateIpcInvokeEnvelope("artifact:save-to-file", save1mTrailingControl)
  );
  bench("worst case: nested array, Date as the last key", () =>
    validateIpcInvokeEnvelope("app:set-state", nestedWithDate)
  );
  bench("weighted mix (100 invokes)", () => {
    for (const [channel, args] of MIX) validateIpcInvokeEnvelope(channel, args);
  });
});
