#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { newCommand } from "./commands/newCommand.js";
import { runValidate } from "./commands/validate.js";
import { runPackage } from "./commands/package.js";
import { runInstall } from "./commands/install.js";
import { runUninstall } from "./commands/uninstall.js";
import { runDev } from "./commands/dev.js";
import { runDoctor } from "./commands/doctor.js";
import { runSchema } from "./commands/schema.js";
import { runTourAlign, runTourVoice, type TourCommandResult } from "./commands/tour.js";
import { runTourPreview } from "./commands/tourPreview.js";
import { CLI_VERSION } from "./version.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const program = new Command();

program
  .name("daintree-plugin")
  .description("Build, validate, package, and install Daintree plugins")
  .version(CLI_VERSION);

// A scaffold failure rejects out of parseAsync and lands in the catch at the
// bottom, which is the same `fail` the other commands call inline.
program.addCommand(newCommand());

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
  .command("doctor")
  .argument("<projectRoot>", "the project whose .daintree/plugins/ to check")
  .description("Check every project plugin the way someone cloning this repository would see it")
  .option("--offline", "skip the query to a running Daintree")
  .action(async (projectRoot: string, opts: { offline?: boolean }) => {
    try {
      const result = await runDoctor(projectRoot, { offline: opts.offline });
      console.log(`Project: ${result.projectRoot}`);
      console.log(`Plugins: ${result.pluginsDir}`);
      console.log(`Daintree: ${result.host.note}`);
      if (result.plugins.length === 0) {
        console.log("\nNo plugin directories found.");
        return;
      }
      for (const plugin of result.plugins) {
        const id = plugin.pluginId ?? "(unreadable manifest)";
        const state = plugin.hostState ? ` — host state: ${plugin.hostState}` : "";
        const mark = plugin.errors.length === 0 ? "✓" : "✗";
        console.log(`\n${mark} ${plugin.dirName} → ${id}${state}`);
        for (const warning of plugin.warnings) console.log(`  ⚠  ${warning}`);
        for (const error of plugin.errors) console.error(`  ✗  ${error}`);
      }
      if (!result.ok) process.exit(1);
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("schema")
  .description(
    "Print the JSON Schema for plugin.json, generated from Daintree's own manifest schema"
  )
  .option("--project", "the schema for a project plugin rather than an installed one")
  .option("--out <file>", "write to a file instead of stdout")
  .action(async (opts: { project?: boolean; out?: string }) => {
    try {
      const written = await runSchema({ project: opts.project, out: opts.out });
      if (written) console.log(`Wrote ${written}`);
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
  .option(
    "--delete-settings",
    "also delete this plugin's user-scope settings (per-project .daintree/ settings are always kept)"
  )
  .action(async (pluginId: string, opts: { deleteSettings?: boolean }) => {
    try {
      await runUninstall(pluginId, { deleteSettings: opts.deleteSettings });
    } catch (err) {
      fail((err as Error).message);
    }
  });

program
  .command("dev")
  .description("Start the hot-reload dev loop for the current plugin")
  .option("--skip-build", "skip the initial Vite build (the watcher still rebuilds on save)")
  .action(async (opts: { skipBuild?: boolean }) => {
    try {
      await runDev({ skipBuild: opts.skipBuild });
    } catch (err) {
      fail((err as Error).message);
    }
  });

function parseOnly(value: string): string[] {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new InvalidArgumentError("name at least one chapter id");
  return ids;
}

function printTourResult(result: TourCommandResult): void {
  for (const chapter of result.chapters) {
    if (chapter.stale) {
      console.log(`⚠  ${chapter.id}: timing is stale — its narration changed since it was made`);
    }
  }
  console.log(`✓ Wrote timing for tour "${result.tourId}" to ${result.manifestPath}`);
}

const tour = program
  .command("tour")
  .description("Voice a tour's narration, time its cues from the audio, and preview it");

tour
  .command("voice")
  .description(
    "Voice each chapter with Inworld TTS (key from INWORLD_API_KEY) and write the audio and timing into the plugin"
  )
  .option("--tour <id>", "which contributes.tours entry (needed when there are several)")
  .option("--narration <file>", "narration file (default: tours/<tourId>.narration.json)")
  .option("--voice <id>", "Inworld voice id", "Simon")
  .option("--model <id>", "Inworld TTS model id (default: inworld-tts-2)")
  .option("--only <ids>", "comma-separated chapter ids", parseOnly)
  .option("--force", "re-voice every chapter, even ones whose narration is unchanged")
  .action(
    async (opts: {
      tour?: string;
      narration?: string;
      voice: string;
      model?: string;
      only?: string[];
      force?: boolean;
    }) => {
      try {
        printTourResult(await runTourVoice({ ...opts, log: (line) => console.log(line) }));
      } catch (err) {
        fail((err as Error).message);
      }
    }
  );

tour
  .command("align")
  .description(
    "Time your own recordings (<chapter-id>.wav|mp3|m4a|ogg|flac|aac) with Inworld speech-to-text; needs ffmpeg"
  )
  .requiredOption("--recordings <dir>", "folder of per-chapter recordings")
  .option("--tour <id>", "which contributes.tours entry (needed when there are several)")
  .option("--narration <file>", "narration file (default: tours/<tourId>.narration.json)")
  .option(
    "--stt-model <id>",
    "an Inworld-routed STT model that returns word timestamps (default: groq/whisper-large-v3)"
  )
  .option("--only <ids>", "comma-separated chapter ids", parseOnly)
  .action(
    async (opts: {
      recordings: string;
      tour?: string;
      narration?: string;
      sttModel?: string;
      only?: string[];
    }) => {
      try {
        printTourResult(await runTourAlign({ ...opts, log: (line) => console.log(line) }));
      } catch (err) {
        fail((err as Error).message);
      }
    }
  );

function parseInteger(min: number, max: number) {
  return (value: string): number => {
    const n = Number(value);
    if (!/^\d+$/.test(value.trim()) || n < min || n > max) {
      throw new InvalidArgumentError(`expected a whole number from ${min} to ${max}`);
    }
    return n;
  };
}

tour
  .command("preview")
  .description(
    "Play and scrub the tour in a browser, with cue markers and anchor outlines; --headless captures a frame at each cue"
  )
  .option("--tour <id>", "which contributes.tours entry (needed when there are several)")
  .option("--narration <file>", "narration file (default: tours/<tourId>.narration.json)")
  .option("--only <ids>", "comma-separated chapter ids", parseOnly)
  .option("--theme <id>", "built-in Daintree theme to draw the scenes in", "daintree")
  .option("--port <port>", "port to serve on (default: any free port)", parseInteger(0, 65535))
  .option("--headless", "capture a frame at each cue with playwright-core instead of serving")
  .option("--out <dir>", "where --headless writes its frames and capture.json")
  .option(
    "--settle <ms>",
    "how long a scene settles after each seek before its frame is taken",
    parseInteger(0, 10_000)
  )
  .action(
    async (opts: {
      tour?: string;
      narration?: string;
      only?: string[];
      theme: string;
      port?: number;
      headless?: boolean;
      out?: string;
      settle?: number;
    }) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const result = await runTourPreview({
          ...opts,
          settleMs: opts.settle,
          signal: controller.signal,
          log: (line) => console.log(line),
          onListening: (url) => {
            if (!opts.headless) console.log(`Previewing tour at ${url} (Ctrl+C to stop)`);
          },
        });
        if (result.capture) {
          const frames = result.capture.manifest.chapters.reduce((n, c) => n + c.frames.length, 0);
          console.log(`✓ Captured ${frames} frames to ${result.capture.manifestPath}`);
        }
      } catch (err) {
        fail((err as Error).message);
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    }
  );

program.parseAsync(process.argv).catch((err) => {
  fail((err as Error).message);
});
