import { Command, CommanderError } from "commander";
import { runNew } from "./new.js";
import { CLI_VERSION } from "../version.js";

/**
 * The `new` command, built once so `daintree-plugin new` and the
 * `create-daintree-plugin` shim parse the same options. The shim used to
 * forward only the positional name, silently dropping `--publisher`,
 * `--template`, `--project` and `--yes`.
 */
export function newCommand(): Command {
  return new Command("new")
    .argument("[name]", "plugin name (also the directory)")
    .description("Scaffold a new plugin project")
    .option("--publisher <publisher>", "publisher segment (e.g. acme)")
    .option("--template <template>", "command | view | mcp | full")
    .option(
      "--project",
      "scaffold into the enclosing project's .daintree/plugins/ (committed, loads with that project)"
    )
    .option("--yes", "non-interactive: accept defaults, skip prompts (requires name + --publisher)")
    .action(
      async (
        name: string | undefined,
        opts: { publisher?: string; template?: string; yes?: boolean; project?: boolean }
      ) => {
        await runNew(name, {
          publisher: opts.publisher,
          template: opts.template,
          yes: opts.yes,
          project: opts.project,
        });
      }
    );
}

/**
 * Parse `argv` (user arguments only, no node/script prefix) exactly as
 * `daintree-plugin new` would and run the scaffold. Rejects rather than exiting
 * so the caller owns the process.
 */
export async function runNewFromArgv(argv: readonly string[]): Promise<void> {
  const command = newCommand()
    .name("create-daintree-plugin")
    .version(CLI_VERSION)
    .exitOverride()
    // The caller prints the rejection; without this commander would print the
    // same "unknown option" line itself first.
    .configureOutput({ outputError: () => {} });
  try {
    await command.parseAsync([...argv], { from: "user" });
  } catch (err) {
    // With `exitOverride`, commander reports `--help` and `--version` as
    // errors too; the text is already on stdout, so they are a clean exit.
    if (err instanceof CommanderError && err.exitCode === 0) return;
    throw err;
  }
}
