import net from "node:net";
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

async function main() {
  const host = process.env.CANOPY_DEV_SERVER_HOST?.trim() || DEFAULT_HOST;
  const requestedPort = parsePort(process.env.CANOPY_DEV_SERVER_PORT) ?? DEFAULT_PORT;
  const port = await findAvailablePort(host, requestedPort);
  const devServerUrl = `http://${host}:${port}`;

  if (port !== requestedPort) {
    console.log(
      `[dev] Port ${requestedPort} is busy, using ${port} for the renderer dev server instead`
    );
  } else {
    console.log(`[dev] Using renderer dev server ${devServerUrl}`);
  }

  const sharedEnv = {
    ...process.env,
    CANOPY_DEV_SERVER_HOST: host,
    CANOPY_DEV_SERVER_PORT: String(port),
    CANOPY_DEV_SERVER_URL: devServerUrl,
  };

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

  await result;
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
