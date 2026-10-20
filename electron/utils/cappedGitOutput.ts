import type { SimpleGit } from "simple-git";
import type { Readable } from "stream";
import { createHardenedGit } from "./hardenedGit.js";

/**
 * Runs `run` on a hardened instance of its own and stops git as soon as one
 * command's stdout passes `maxBytes`, resolving `null` instead of the output.
 *
 * simple-git buffers every stdout chunk before any handler sees it, so the
 * only way to bound memory is to stop the child: aborting the instance's own
 * signal kills it, and destroying stdout drops whatever git had already
 * written to the pipe. At most one chunk past the cap is ever held. The
 * instance is private to the call because both the signal and the output
 * handler are bound to it and would otherwise reach unrelated commands.
 */
export async function runWithCappedStdout(
  cwd: string,
  maxBytes: number,
  run: (git: SimpleGit) => Promise<string>
): Promise<string | null> {
  const controller = new AbortController();
  const git = await createHardenedGit(cwd, controller.signal);
  let exceeded = false;
  git.outputHandler((_command, stdout) => {
    let bytes = 0;
    stdout.on("data", (chunk: Buffer | string) => {
      if (exceeded) return;
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes <= maxBytes) return;
      exceeded = true;
      controller.abort();
      // simple-git types the pipe as NodeJS.ReadableStream, which has no destroy.
      (stdout as Readable).destroy();
    });
  });

  try {
    const output = await run(git);
    return exceeded ? null : output;
  } catch (error) {
    if (exceeded) return null;
    throw error;
  }
}
