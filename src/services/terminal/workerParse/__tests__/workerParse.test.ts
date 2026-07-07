import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ParseAuthority } from "../parseAuthority";
import {
  applySnapshotToMirror,
  buildMirrorApplyPayload,
  CLEAR_ALL,
  MIRROR_RESET,
  SYNC_OUTPUT_END,
  SYNC_OUTPUT_START,
} from "../mirrorApply";
import { createInThreadTransport } from "../parseTransport";
import type { AuthorityResponse, AuthorityTransport } from "../parseTransport";
import { WorkerParseSession } from "../WorkerParseSession";

function makeMirror(options: { cols?: number; rows?: number; scrollback?: number } = {}) {
  const terminal = new Terminal({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 1000,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon as unknown as Parameters<Terminal["loadAddon"]>[0]);
  return { terminal, serializeAddon };
}

function bufferText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").replace(/\n+$/, "");
}

function drain(terminal: Terminal): Promise<void> {
  return new Promise((resolve) => terminal.write("", () => resolve()));
}

const COLORED_STREAM =
  "\x1b[31mred line\x1b[0m\r\n" +
  "\x1b[1;32mbold green\x1b[0m\r\n" +
  "plain text with \x1b[44mblue background\x1b[0m\r\n" +
  "cursor moves: \x1b[2Aup\x1b[2Bdown\r\n";

describe("ParseAuthority + mirror apply", () => {
  it("a full snapshot applied to a mirror reproduces the authority's state, colors included", async () => {
    const authority = new ParseAuthority({ cols: 80, rows: 24, scrollback: 1000 });
    for (let i = 0; i < 50; i += 1) {
      authority.write(`line ${i} `);
      authority.write(COLORED_STREAM);
    }

    const snapshot = await authority.takeSnapshot(undefined);
    expect(snapshot).not.toBeNull();

    const mirror = makeMirror();
    applySnapshotToMirror(mirror.terminal, snapshot!.serialized);
    await drain(mirror.terminal);

    expect(bufferText(mirror.terminal)).toBe(authority.bufferText());
    // Style-preserving equivalence: re-serializing the mirror reproduces the
    // authority's serialization (SGR attributes included), so colors survived.
    const reserialized = mirror.serializeAddon.serialize();
    const authoritySerialized = snapshot!.serialized;
    expect(reserialized).toBe(authoritySerialized);

    authority.dispose();
    mirror.terminal.dispose();
  });

  it("bounded snapshots cap the apply cost and clean authorities skip the tick", async () => {
    const authority = new ParseAuthority({ cols: 80, rows: 10, scrollback: 5000 });
    for (let i = 0; i < 2000; i += 1) authority.write(`scroll line ${i}\r\n`);

    const bounded = await authority.takeSnapshot(50);
    expect(bounded).not.toBeNull();

    // Everything since is clean → the cadence tick becomes a no-op.
    expect(await authority.takeSnapshot(50)).toBeNull();

    authority.write("one more\r\n");
    const full = await authority.takeSnapshot(undefined);
    expect(full).not.toBeNull();
    expect(bounded!.serialized.length).toBeLessThan(full!.serialized.length / 5);

    // The bounded apply leaves the mirror with a bounded buffer.
    const mirror = makeMirror({ rows: 10, scrollback: 5000 });
    applySnapshotToMirror(mirror.terminal, bounded!.serialized);
    await drain(mirror.terminal);
    expect(mirror.terminal.buffer.active.length).toBeLessThanOrEqual(50 + 10);

    authority.dispose();
    mirror.terminal.dispose();
  });

  it("wraps the apply payload in synchronized output around a reset + full clear", () => {
    const payload = buildMirrorApplyPayload("CONTENT");
    expect(payload.startsWith(SYNC_OUTPUT_START + MIRROR_RESET + CLEAR_ALL)).toBe(true);
    expect(payload.endsWith(SYNC_OUTPUT_END)).toBe(true);
    expect(payload).toContain("CONTENT");
  });
});

describe("WorkerParseSession", () => {
  it("coalesces a flood into one mirror apply per tick", async () => {
    const writes: string[] = [];
    const mirror = { write: (data: string, cb?: () => void) => (writes.push(data), cb?.()) };
    const session = new WorkerParseSession(createInThreadTransport(), mirror, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });

    for (let i = 0; i < 100; i += 1) session.feed(`flood line ${i}\r\n`);
    await session.tickNow();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("flood line 99");

    // Idle tick: no repaint.
    await session.tickNow();
    expect(writes).toHaveLength(1);

    session.dispose();
  });

  it("promotion is zero-loss: snapshot bytes, mid-promotion bytes, passthrough bytes — once each, in order", async () => {
    const mirror = makeMirror();
    const mirrorTarget = {
      write: (data: string, cb?: () => void) => mirror.terminal.write(data, cb),
    };
    const session = new WorkerParseSession(createInThreadTransport(), mirrorTarget, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });

    session.feed("before-promotion\r\n");
    const promotion = session.promoteToInteractive();
    // Arrives while the full snapshot is in flight → must replay after it.
    session.feed("during-promotion\r\n");
    await promotion;
    expect(session.currentMode()).toBe("passthrough");
    session.feed("after-promotion\r\n");
    await drain(mirror.terminal);

    const text = bufferText(mirror.terminal);
    const order = [
      text.indexOf("before-promotion"),
      text.indexOf("during-promotion"),
      text.indexOf("after-promotion"),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // Exactly once each — nothing duplicated by the snapshot/replay boundary.
    for (const marker of ["before-promotion", "during-promotion", "after-promotion"]) {
      expect(text.split(marker)).toHaveLength(2);
    }

    session.dispose();
    mirror.terminal.dispose();
  });

  it("demotion re-seeds the authority from the mirror's serialized state", async () => {
    const mirror = makeMirror();
    const mirrorTarget = {
      write: (data: string, cb?: () => void) => mirror.terminal.write(data, cb),
    };
    const session = new WorkerParseSession(createInThreadTransport(), mirrorTarget, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });

    session.feed("worker-era\r\n");
    await session.promoteToInteractive();
    session.feed("passthrough-era\r\n");
    await drain(mirror.terminal);

    session.demoteToWorker(mirror.serializeAddon.serialize());
    expect(session.currentMode()).toBe("worker");
    session.feed("worker-again\r\n");
    await session.tickNow();
    await drain(mirror.terminal);

    const text = bufferText(mirror.terminal);
    expect(text).toContain("worker-era");
    expect(text).toContain("passthrough-era");
    expect(text).toContain("worker-again");

    session.dispose();
    mirror.terminal.dispose();
  });

  it("promotion after a bounded cadence tick still restores full fidelity", async () => {
    const mirror = makeMirror({ rows: 10, scrollback: 5000 });
    const mirrorTarget = {
      write: (data: string, cb?: () => void) => mirror.terminal.write(data, cb),
    };
    const session = new WorkerParseSession(createInThreadTransport(), mirrorTarget, {
      cols: 80,
      rows: 10,
      scrollback: 5000,
      cadenceMs: 0,
      boundedScrollbackLines: 50,
    });

    for (let i = 0; i < 500; i += 1) session.feed(`fidelity line ${i}\r\n`);
    await session.tickNow();
    await drain(mirror.terminal);
    // The cadence mirror is truncated to the bound...
    expect(mirror.terminal.buffer.active.length).toBeLessThanOrEqual(60);

    // ...and the authority is clean now — promotion must STILL take a full
    // snapshot (sync-point fidelity), not skip because nothing is dirty.
    await session.promoteToInteractive();
    await drain(mirror.terminal);
    expect(mirror.terminal.buffer.active.length).toBeGreaterThan(400);
    expect(bufferText(mirror.terminal)).toContain("fidelity line 0");

    session.dispose();
    mirror.terminal.dispose();
  });

  it("mirrors alternate-screen entry AND exit across snapshots", async () => {
    const mirror = makeMirror();
    const mirrorTarget = {
      write: (data: string, cb?: () => void) => mirror.terminal.write(data, cb),
    };
    const session = new WorkerParseSession(createInThreadTransport(), mirrorTarget, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });

    session.feed("normal content\r\n");
    session.feed("\x1b[?1049h\x1b[2J\x1b[Halt-screen content");
    await session.tickNow();
    await drain(mirror.terminal);
    expect(mirror.terminal.buffer.active.type).toBe("alternate");

    // The authority leaves the alt screen; the serialize addon emits no
    // ?1049l for a normal-buffer snapshot, so the apply prefix must reset it.
    session.feed("\x1b[?1049l");
    session.feed("back to normal\r\n");
    await session.tickNow();
    await drain(mirror.terminal);
    expect(mirror.terminal.buffer.active.type).toBe("normal");
    expect(bufferText(mirror.terminal)).toContain("back to normal");

    session.dispose();
    mirror.terminal.dispose();
  });

  it("does not leak stateful input modes across snapshots", async () => {
    const mirror = makeMirror();
    const mirrorTarget = {
      write: (data: string, cb?: () => void) => mirror.terminal.write(data, cb),
    };
    const session = new WorkerParseSession(createInThreadTransport(), mirrorTarget, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });

    session.feed("\x1b[?2004h"); // bracketed paste on
    session.feed("with paste mode\r\n");
    await session.tickNow();
    await drain(mirror.terminal);
    expect(mirror.terminal.modes.bracketedPasteMode).toBe(true);

    session.feed("\x1b[?2004l"); // authority back to default
    session.feed("without paste mode\r\n");
    await session.tickNow();
    await drain(mirror.terminal);
    expect(mirror.terminal.modes.bracketedPasteMode).toBe(false);

    session.dispose();
    mirror.terminal.dispose();
  });

  it("a second promotion during the first is a no-op and both resolve", async () => {
    const mirror = makeMirror();
    const mirrorTarget = {
      write: (data: string, cb?: () => void) => mirror.terminal.write(data, cb),
    };
    const session = new WorkerParseSession(createInThreadTransport(), mirrorTarget, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });
    session.feed("content\r\n");
    const first = session.promoteToInteractive();
    const second = session.promoteToInteractive();
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(session.currentMode()).toBe("passthrough");

    session.dispose();
    mirror.terminal.dispose();
  });

  it("demotion re-syncs geometry before restoring the authority", async () => {
    const requests: Array<{ type: string; cols?: number }> = [];
    const inner = createInThreadTransport();
    const recording = {
      send: (request: Parameters<typeof inner.send>[0]) => {
        requests.push({ type: request.type, cols: "cols" in request ? request.cols : undefined });
        inner.send(request);
      },
      onResponse: inner.onResponse.bind(inner),
      dispose: inner.dispose.bind(inner),
    };
    const mirror = { write: (_: string, cb?: () => void) => cb?.() };
    const session = new WorkerParseSession(recording, mirror, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });

    await session.promoteToInteractive();
    // Resized while in passthrough — the authority hears nothing yet.
    session.resize(100, 40);
    expect(requests.filter((r) => r.type === "resize")).toHaveLength(0);

    session.demoteToWorker("serialized-state");
    const tail = requests.slice(-2);
    expect(tail.map((r) => r.type)).toEqual(["resize", "restore"]);
    expect(tail[0]!.cols).toBe(100);

    session.dispose();
  });

  it("dispose resolves in-flight promotions instead of hanging them", async () => {
    const mirror = { write: (_: string, cb?: () => void) => cb?.() };
    const session = new WorkerParseSession(createInThreadTransport(), mirror, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });
    const promotion = session.promoteToInteractive();
    session.dispose();
    await expect(promotion).resolves.toBeUndefined();
  });

  it("a requestId-less worker crash settles in-flight promotions instead of hanging them", async () => {
    // A whole-worker crash surfaces as an error response with NO requestId
    // (transport onerror, or a non-snapshot endpoint failure). With `send` a
    // no-op the snapshot request never gets a reply, so the promotion is stuck
    // awaiting requestSnapshot until the crash settles it.
    let notify: ((response: AuthorityResponse) => void) | undefined;
    const transport: AuthorityTransport = {
      send: () => {},
      onResponse: (listener) => {
        notify = listener;
        return () => {};
      },
      dispose: () => {},
    };
    const mirror = { write: (_: string, cb?: () => void) => cb?.() };
    const session = new WorkerParseSession(transport, mirror, {
      cols: 80,
      rows: 24,
      scrollback: 1000,
      cadenceMs: 0,
    });
    const promotion = session.promoteToInteractive();
    notify?.({ type: "error", message: "parse worker error" });
    await expect(promotion).resolves.toBeUndefined();

    session.dispose();
  });
});
