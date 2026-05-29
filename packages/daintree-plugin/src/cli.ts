#!/usr/bin/env node
import { Command } from "commander";
import { runNew } from "./commands/new.js";
import { runValidate } from "./commands/validate.js";
import { runPackage } from "./commands/package.js";
import { runInstall } from "./commands/install.js";
import { runUninstall } from "./commands/uninstall.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const program = new Command();

program
  .name("daintree-plugin")
  .description("Build, validate, package, and install Daintree plugins")
  .version("0.1.0");

program
  .command("new")
  .argument("[name]", "plugin name (also the directory)")
  .description("Scaffold a new plugin project")
  .action(async (name?: string) => {
    try {
      await runNew(name);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("validate")
  .description("Validate plugin.json against Daintree's manifest schema")
  .option("--env", "resolve ${settings:…} tokens against .daintree-plugin-env")
  .action(async (opts: { env?: boolean }) => {
    try {
      const result = await runValidate({ env: opts.env });
      if (result.ok) {
        console.log("✓ plugin.json is valid");
      }
      for (const warning of result.warnings) {
        console.log(`⚠  ${warning}`);
      }
      if (!result.ok) {
        for (const error of result.errors) {
          console.error(`✗  ${error}`);
        }
        process.exit(1);
      }
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("package")
  .description("Produce a distributable .dntr file")
  .option("--verbose", "list every included file")
  .option("--dry-run", "preview the file list without writing the archive")
  .option("--sourcemaps", "include source maps in the archive")
  .option("--skip-build", "skip the Vite build step")
  .action(
    async (opts: {
      verbose?: boolean;
      dryRun?: boolean;
      sourcemaps?: boolean;
      skipBuild?: boolean;
    }) => {
      try {
        await runPackage({
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          sourcemaps: opts.sourcemaps,
          skipBuild: opts.skipBuild,
        });
      } catch (err) {
        fail((err as Error).message);
      }
    }
  );

program
  .command("install")
  .argument("<path-or-url>", "a .dntr file path or URL")
  .description("Install a plugin into the running Daintree")
  .action(async (target: string) => {
    try {
      await runInstall(target);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("uninstall")
  .argument("<pluginId>", "scoped plugin id (publisher.name)")
  .description("Uninstall a plugin from the running Daintree")
  .action(async (pluginId: string) => {
    try {
      await runUninstall(pluginId);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("dev")
  .description("Start the hot-reload dev loop (not yet available — planned for F32b)")
  .action(() => {
    fail("The hot-reload dev loop isn't available yet — planned for a later release (F32b).");
  });

program.parseAsync(process.argv).catch((err) => {
  fail((err as Error).message);
});
