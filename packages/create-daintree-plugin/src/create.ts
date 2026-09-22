#!/usr/bin/env node
import { createRequire } from "node:module";
import { runNewFromArgv } from "daintree-plugin";

// `--version` reports this package, not `daintree-plugin`; `../package.json`
// resolves from both `src/` and `dist/`.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/**
 * `npm create daintree-plugin <name> [options]` / `npx create-daintree-plugin
 * <name> [options]`. A thin shim over `daintree-plugin new` that forwards the
 * whole argument list, so `--publisher`, `--template`, `--project` and `--yes`
 * behave exactly as they do there.
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

runNewFromArgv(process.argv.slice(2), version).catch((err: unknown) => {
  console.error(messageOf(err));
  process.exit(1);
});
