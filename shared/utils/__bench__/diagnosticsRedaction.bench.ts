import { bench, describe } from "vitest";
import { applyReplacementsCounted, PREBUILT_REDACTIONS } from "../diagnosticsTransform.js";
import type { ReplacementRule } from "../diagnosticsTransform.js";
import { legacyApplyReplacementsCounted } from "./legacyApplyReplacements.js";

function makePayload(targetBytes: number): string {
  const entries: unknown[] = [];
  let i = 0;
  let size = 0;
  while (size < targetBytes) {
    const e = {
      timestamp: 1_700_000_000_000 + i,
      level: "info",
      message: `user u${i}@example.com connected from 10.${i % 256}.${(i * 7) % 256}.${
        (i * 13) % 256
      } opened /Users/alice/Projects/app${i % 50}/src/file${i}.ts token-${i}`,
    };
    entries.push(e);
    size += 190;
    i++;
  }
  return JSON.stringify({ logs: { recentEntries: entries } }, null, 2);
}

const rules: ReplacementRule[] = PREBUILT_REDACTIONS.flatMap((p) => p.rules).filter(
  (_, idx) => idx !== 2 && idx !== 3
);
rules.push({ kind: "literal", find: "token-", replace: "T-" });

for (const mb of [1, 3]) {
  const json = makePayload(mb * 1024 * 1024);
  describe(`redaction rules on ~${mb} MB JSON`, () => {
    bench("legacy", () => void legacyApplyReplacementsCounted(json, rules), {
      iterations: 3,
      warmupIterations: 1,
    });
    bench("current", () => void applyReplacementsCounted(json, rules), {
      iterations: 3,
      warmupIterations: 1,
    });
  });
}
