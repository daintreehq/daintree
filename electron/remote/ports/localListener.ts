import net from "node:net";

/**
 * Local listeners for forwarded ports. A forward binds the same port number
 * it has on the Host when it can, so absolute URLs, redirects and OAuth
 * callbacks the Host's server builds from its own port still land on it.
 *
 * Browsers resolve `localhost` to both loopback families, so a port counts as
 * free only when neither 127.0.0.1 nor ::1 has it: a forward on one family
 * beside an unrelated local server on the other would send some requests to
 * the wrong machine.
 */

const IPV4 = "127.0.0.1";
const IPV6 = "::1";
const EPHEMERAL_ATTEMPTS = 8;
const ANSWER_PROBE_MS = 300;

export type ConnectionHandler = (socket: net.Socket) => void;

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve((server.address() as net.AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, exclusive: true });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function makeServer(onConnection: ConnectionHandler): net.Server {
  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, onConnection);
  server.unref();
  return server;
}

/**
 * Bind `port` (0 for any) on IPv4 loopback and the same port on IPv6
 * loopback. Machines without IPv6 loopback keep the IPv4 listener alone.
 * Rejects when either family already has the port.
 */
async function bindBoth(port: number, onConnection: ConnectionHandler): Promise<net.Server[]> {
  const v4 = makeServer(onConnection);
  const bound = await listen(v4, port, IPV4);
  const v6 = makeServer(onConnection);
  try {
    await listen(v6, bound, IPV6);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return [v4];
    await close(v4);
    throw error;
  }
  return [v4, v6];
}

/**
 * Whether something on this machine accepts connections on `port` at `host`.
 * A failed bind is not enough: with SO_REUSEADDR a loopback bind can succeed
 * beside another process's wildcard listener and quietly shadow it.
 */
function isAnswering(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (answered: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), ANSWER_PROBE_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function isTakenLocally(port: number): Promise<boolean> {
  const answers = await Promise.all([isAnswering(port, IPV4), isAnswering(port, IPV6)]);
  return answers.some(Boolean);
}

export interface LoopbackListener {
  port: number;
  servers: net.Server[];
  close(): Promise<void>;
}

/** Listen on `preferredPort` when both families have it free, else on a free port both have. */
export async function listenLoopback(
  preferredPort: number,
  onConnection: ConnectionHandler
): Promise<LoopbackListener> {
  const wrap = (servers: net.Server[]): LoopbackListener => ({
    port: (servers[0]!.address() as net.AddressInfo).port,
    servers,
    close: async () => {
      await Promise.all(servers.map(close));
    },
  });
  if (preferredPort !== 0 && !(await isTakenLocally(preferredPort))) {
    try {
      return wrap(await bindBoth(preferredPort, onConnection));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    }
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < EPHEMERAL_ATTEMPTS; attempt++) {
    try {
      return wrap(await bindBoth(0, onConnection));
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw lastError;
}

/**
 * A port both loopback families have free right now, preferring
 * `preferredPort`, for a forward something else (ssh) will bind. The port is
 * released before this returns, so another process could take it first; the
 * binder's own failure covers that.
 */
export async function probeFreeLoopbackPort(preferredPort: number): Promise<number> {
  const listener = await listenLoopback(preferredPort, (socket) => socket.destroy());
  const { port } = listener;
  await listener.close();
  return port;
}
