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

/**
 * A request made before the port arrives is rejected in preload and never
 * reaches the broker, so this warning is main's only record of it (#12759).
 */
describe("preload worktree request without a port", () => {
  let branch: string;

  beforeAll(async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");
    const start = source.indexOf("if (!this.port) {\n      // Main can't see this rejection");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n    }\n", start);
    expect(end).toBeGreaterThan(start);
    branch = source.slice(start, end);
  });

  it("warns with the requested action before rejecting", () => {
    const warnIdx = branch.indexOf(
      'console.warn(`[Preload] Worktree port request "${String(action)}" rejected: port not ready`)'
    );
    const rejectIdx = branch.indexOf('new BrokerError("HOST_EXITED", "Worktree port not ready")');
    expect(warnIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeGreaterThan(warnIdx);
  });
});
