import { readFile } from "fs/promises";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

const PRELOAD_CTS = path.resolve(__dirname, "../../preload.cts");

/**
 * The broker only reuses a port the renderer has acknowledged (#12576), and its
 * suites fabricate those receipts — so they would keep passing if the preload
 * stopped sending them. This pins the preload half of the handshake.
 */
describe("preload worktree port receipt", () => {
  let listener: string;

  beforeAll(async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");
    const start = source.indexOf('ipcRenderer.on("worktree-port"');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n});", start);
    expect(end).toBeGreaterThan(start);
    listener = source.slice(start, end);
  });

  it("acknowledges the transfer on the receipt channel with the broker's token", () => {
    expect(listener).toContain("ipcRenderer.send(CHANNELS.WORKTREE_PORT_ACK, { token })");
    expect(listener).toMatch(/typeof token === "number"/);
  });

  it("acknowledges only after attaching, so the ready callbacks have already run", () => {
    // Retry resolves on this receipt; the ready callbacks it follows are what
    // restart the renderer's fetch and put the skeleton back up.
    const attachIdx = listener.indexOf("worktreePortClient.attach(event.ports[0])");
    const ackIdx = listener.indexOf("CHANNELS.WORKTREE_PORT_ACK");
    expect(attachIdx).toBeGreaterThan(-1);
    expect(ackIdx).toBeGreaterThan(attachIdx);
  });

  it("sends nothing for a message that carried no port", () => {
    const guardIdx = listener.indexOf("if (!event.ports || event.ports.length === 0) return;");
    const ackIdx = listener.indexOf("CHANNELS.WORKTREE_PORT_ACK");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(ackIdx);
  });
});
