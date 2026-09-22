#!/usr/bin/env node
import { runNewFromArgv } from "daintree-plugin";

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

runNewFromArgv(process.argv.slice(2)).catch((err: unknown) => {
  console.error(messageOf(err));
  process.exit(1);
});
