import { app } from "electron";
import {
  ASKPASS_PROMPT_ENV,
  ASKPASS_SOCKET_ENV,
  ASKPASS_TOKEN_ENV,
  runAskpassClient,
} from "./sshAskpass.js";

/**
 * `daintree --ssh-askpass`: ssh's askpass during a Remote Hosts sign-in.
 * Started by bootstrap.ts before anything else (no store, no compile cache,
 * never main.js), so it touches no state and is never handed to the running
 * instance as a second launch. stdout carries the answer to ssh, so nothing
 * else may write to it.
 */
export async function runSshAskpassCli(): Promise<number> {
  const toStderr =
    (level: string) =>
    (...args: unknown[]) => {
      process.stderr.write(`[ssh-askpass] ${level} ${args.map(String).join(" ")}\n`);
    };
  console.log = toStderr("log");
  console.info = toStderr("info");
  console.debug = toStderr("debug");
  console.warn = toStderr("warn");
  try {
    app.dock?.hide();
  } catch {
    // Not every launch context has a Dock.
  }
  const socketPath = process.env[ASKPASS_SOCKET_ENV];
  const token = process.env[ASKPASS_TOKEN_ENV];
  if (!socketPath || !token) {
    process.stderr.write("daintree: --ssh-askpass runs only under a Daintree sign-in\n");
    return 1;
  }
  const client = runAskpassClient({
    socketPath,
    token,
    prompt: process.env[ASKPASS_PROMPT_ENV] ?? "",
    hint: process.env.SSH_ASKPASS_PROMPT ?? "",
    writeAnswer: (answer) =>
      new Promise((resolve, reject) => {
        process.stdout.write(`${answer}\n`, (error) => (error ? reject(error) : resolve()));
      }),
  });
  // ssh stops a notice's askpass with SIGTERM once the key is touched, and
  // waits for it to exit before going on.
  const stop = () => client.stop();
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  try {
    return await client.done;
  } finally {
    for (const signal of signals) process.off(signal, stop);
  }
}
