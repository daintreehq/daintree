/** A small inventory CLI: enough code for an agent to read, review or change. */
export const INVENTORY_PROJECT: Record<string, string> = {
  "README.md": `# stockroom

A small command-line tool that tracks warehouse stock levels. It reads a CSV of
items, applies receipts and shipments, and warns when an item falls below its
reorder point.

Run \`node src/cli.js report stock.csv\` to print the current levels.
`,
  "package.json": JSON.stringify(
    { name: "stockroom", version: "0.3.0", private: true, scripts: { test: "node --test" } },
    null,
    2
  ),
  "src/stock.js": `export function applyMovement(levels, movement) {
  const current = levels.get(movement.sku) ?? 0;
  // TODO: shipments larger than stock silently go negative
  levels.set(movement.sku, current + movement.quantity);
  return levels;
}

export function belowReorderPoint(levels, reorderPoints) {
  return [...levels].filter(([sku, qty]) => qty < (reorderPoints.get(sku) ?? 0));
}
`,
  "src/csv.js": `export function parseCsv(text) {
  // Naive: breaks on quoted commas.
  return text.trim().split("\\n").map((line) => line.split(","));
}
`,
  "src/cli.js": `import { readFileSync } from "node:fs";
import { parseCsv } from "./csv.js";
import { applyMovement } from "./stock.js";

const [, , command, file] = process.argv;
if (command !== "report") {
  console.error("usage: cli.js report <file>");
  process.exit(1);
}
const levels = new Map();
for (const [sku, quantity] of parseCsv(readFileSync(file, "utf8"))) {
  applyMovement(levels, { sku, quantity: Number(quantity) });
}
for (const [sku, qty] of levels) console.log(sku, qty);
`,
  "stock.csv": "A-100,12\nB-200,4\nA-100,-3\nC-300,40\n",
  "test/stock.test.js": `import { test } from "node:test";
import assert from "node:assert";
import { applyMovement } from "../src/stock.js";

test("applies a receipt", () => {
  const levels = applyMovement(new Map(), { sku: "A", quantity: 5 });
  assert.equal(levels.get("A"), 5);
});
`,
};
