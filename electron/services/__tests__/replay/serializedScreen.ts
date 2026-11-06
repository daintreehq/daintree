import { readFileSync } from "node:fs";

/**
 * Replay an asciicast v2 recording through a headless xterm and serialize the
 * screen as the pty-host does, stopping at the marker event (`[t, "m", label]`)
 * named `marker`. Real timers and a real `SerializeAddon`, so the result is the
 * byte shape every terminal read starts from.
 */
export async function serializeCastAt(
  path: string,
  marker: string,
  scrollback?: number
): Promise<string> {
  const [headerLine, ...eventLines] = readFileSync(path, "utf8").trim().split("\n");
  const header = JSON.parse(headerLine!) as { width: number; height: number };
  const events = eventLines.map((line) => JSON.parse(line) as [number, string, string]);
  const stop = events.findIndex(([, kind, data]) => kind === "m" && data === marker);
  if (stop === -1) throw new Error(`No marker "${marker}" in ${path}`);

  const output = events
    .slice(0, stop)
    .filter(([, kind]) => kind === "o")
    .map(([, , data]) => data);
  return serializeOutput(output, header.width, header.height, scrollback);
}

/** Write `output` to a headless xterm of this size and serialize it, as {@link serializeCastAt} does. */
export async function serializeOutput(
  output: string | readonly string[],
  cols = 80,
  rows = 10,
  scrollback?: number
): Promise<string> {
  const { Terminal } = await import("@xterm/headless");
  const { SerializeAddon } = (await import("@xterm/addon-serialize")).default;
  const terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  const addon = new SerializeAddon();
  try {
    terminal.loadAddon(addon);
    for (const data of typeof output === "string" ? [output] : output) {
      await new Promise<void>((resolve) => terminal.write(data, resolve));
    }
    return addon.serialize(scrollback === undefined ? undefined : { scrollback });
  } finally {
    addon.dispose();
    terminal.dispose();
  }
}
