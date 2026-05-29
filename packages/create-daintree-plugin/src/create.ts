#!/usr/bin/env node
import { runNew } from "daintree-plugin";

/**
 * `npm create daintree-plugin <name>` / `npx create-daintree-plugin <name>`.
 * A thin shim that forwards the positional name to `daintree-plugin new`.
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const name = process.argv[2];

runNew(name).catch((err: unknown) => {
  console.error(messageOf(err));
  process.exit(1);
});
