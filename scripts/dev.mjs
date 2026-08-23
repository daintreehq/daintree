import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import concurrently from "concurrently";

const DEFAULT_PORT = 5173;
const DEFAULT_HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 25;
let interrupted = false;

function parsePort(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

async function findAvailablePort(host, startPort) {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    if (await canListen(host, port)) {
      return port;
    }
  }

  throw new Error(
    `Could not find an available dev server port starting at ${startPort} on ${host}`
  );
}

/**
 * Rebuilds the vendored assistant engine before the app starts.
 *
 * `resources/assistant/` is written only by an explicit `npm run build:assistant`, so
 * before this the engine could sit several submodule commits behind the code that
 * embeds it — and the app ran the old one without a word. A fix could be made, tested,
 * committed and pinned, and still reproduce, because the binary being launched predated
 * it. The Go build is incremental and takes a few hundred milliseconds when nothing has
 * changed, which is a fair price for never debugging the wrong engine again.
 *
 * `--dev` makes it non-fatal: no Go, no submodule, or a compile error leaves whatever
 * was built before in place and prints why.
 */
function buildAssistantEngine() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "build-assistant.mjs");
  const result = spawnSync(process.execPath, [script, "--dev"], { stdio: "inherit" });
  if (result.status !== 0) {
    // Already reported by the script itself, and already decided to be survivable
    // there — a second opinion here would only be noise.
    console.warn("[dev] continuing without a fresh assistant engine build");
  }
}

async function main() {
  buildAssistantEngine();
  const host = process.env.DAINTREE_DEV_SERVER_HOST?.trim() || DEFAULT_HOST;
  const requestedPort = parsePort(process.env.DAINTREE_DEV_SERVER_PORT) ?? DEFAULT_PORT;
  const port = await findAvailablePort(host, requestedPort);
  const devServerUrl = `http://${host}:${port}`;
  const freshUserDataDir =
    process.env.DAINTREE_RESET_DATA === "1"
      ? fs.mkdtempSync(path.join(os.tmpdir(), "daintree-dev-fresh-"))
      : null;

  if (port !== requestedPort) {
    console.log(
      `[dev] Port ${requestedPort} is busy, using ${port} for the renderer dev server instead`
    );
  } else {
    console.log(`[dev] Using renderer dev server ${devServerUrl}`);
  }

  const sharedEnv = {
    ...process.env,
    DAINTREE_DEV_SERVER_HOST: host,
    DAINTREE_DEV_SERVER_PORT: String(port),
    DAINTREE_DEV_SERVER_URL: devServerUrl,
    ...(freshUserDataDir ? { DAINTREE_DEV_USER_DATA_DIR: freshUserDataDir } : {}),
  };
  delete sharedEnv.ELECTRON_RUN_AS_NODE;
  delete sharedEnv.ATOM_SHELL_INTERNAL_RUN_AS_NODE;

  if (freshUserDataDir) {
    console.log(`[dev] Using fresh Electron userData ${freshUserDataDir}`);
  }

  const { result } = concurrently(
    [
      {
        command: "npm run watch:main",
        env: sharedEnv,
        name: "main",
      },
      {
        command: `vite --host ${host} --port ${port} --strictPort`,
        env: sharedEnv,
        name: "vite",
      },
      {
        command: `wait-on dist-electron/.build-ready.js tcp:${host}:${port} && npm run dev:electron`,
        env: sharedEnv,
        name: "electron",
      },
    ],
    {
      handleInput: true,
      killOthersOn: ["failure", "success"],
      prefix: "[{name}]",
      prefixColors: ["blue", "green", "yellow"],
      successCondition: "first",
    }
  );

  try {
    await result;
  } finally {
    if (freshUserDataDir && process.env.DAINTREE_KEEP_FRESH_PROFILE !== "1") {
      fs.rmSync(freshUserDataDir, { recursive: true, force: true });
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
  });
}

main().catch((error) => {
  if (
    interrupted ||
    (Array.isArray(error) &&
      error.length > 0 &&
      error.every((entry) => entry?.killed || entry?.exitCode === "SIGTERM"))
  ) {
    process.exit(0);
  }

  console.error("[dev] Failed to start development environment:", error);
  process.exit(1);
});
