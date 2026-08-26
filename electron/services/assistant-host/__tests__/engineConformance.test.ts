import { describe, it, expect } from "vitest";
import { open, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseAssistantHostEvent,
  AssistantHostEventSchema,
  ASSISTANT_HOST_PROTOCOL_VERSION,
} from "../../../schemas/ipc.js";
import { binary, driveEngine } from "./engineHarness.js";

/**
 * CROSS-REPO CONFORMANCE.
 *
 * This is the guard for the failure that actually happened to this protocol: Daintree
 * and the engine each described the wire in their own repo, nothing compared the two,
 * and they silently drifted three versions apart. Type-level parity (in
 * `electron/schemas/ipc.ts`) proves Daintree agrees with ITSELF. Only running the real
 * binary proves Daintree agrees with the ENGINE.
 *
 * So this spawns the vendored engine and validates its actual bytes against the Zod
 * schema the main process uses in production. A field the engine renames, drops, or
 * retypes fails here — in a fast unit run — instead of at a user's first turn.
 *
 * It needs no backend and no MCP: booting to `host:ready` and shutting down exercises
 * the handshake, the framing, the sequence stamping, and several event shapes. The
 * engine reports a degraded MCP on stderr and carries on, which is itself part of the
 * contract being asserted (diagnostics never contaminate the protocol stream).
 *
 * The boot harness itself lives in `engineHarness.ts`, shared with the tier-binding
 * suite.
 */

describe.skipIf(!binary)("assistant engine wire conformance", () => {
  it("emits frames that validate against Daintree's own schema", async () => {
    const sessionId = "ses_conformance";
    const { frames, stderr, exitCode } = await driveEngine(binary!, sessionId);

    expect(frames.length, `engine emitted no frames. stderr:\n${stderr}`).toBeGreaterThan(0);

    for (const frame of frames) {
      const parsed = AssistantHostEventSchema.safeParse(frame);
      expect(
        parsed.success,
        `engine emitted a frame Daintree cannot parse — the two repos have drifted.\n` +
          `frame: ${JSON.stringify(frame)}\n` +
          `error: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`
      ).toBe(true);
    }

    expect(exitCode).toBe(0);
  }, 40_000);

  it("agrees on the protocol version", async () => {
    const { frames } = await driveEngine(binary!, "ses_version");
    const ready = frames.map(parseAssistantHostEvent).find((e) => e?.type === "host:ready");

    expect(ready, "engine never signalled host:ready").toBeDefined();
    // The whole point: if these disagree, the submodule pin and Daintree's protocol
    // constant have come apart and every session would be refused at the handshake.
    expect(ready).toMatchObject({ protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION });
  }, 40_000);

  it("stamps a monotonic sequence starting at 1", async () => {
    const { frames } = await driveEngine(binary!, "ses_seq");
    const seqs = frames.map((f) => (f as { seq: number }).seq);

    // seq is what makes a lost frame detectable instead of silent. Starting at 1 lets
    // a consumer treat 0 as "nothing seen yet" without ambiguity.
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  }, 40_000);

  it("boots against a state database from an older schema", async () => {
    // The upgrade path for anyone who has used the assistant before, and it was fatal.
    // The engine hard-resets its SQLite baseline rather than migrating, and the host was
    // the one surface with no recovery wired: it answered `host:error` — "database
    // schema is stale … run 'make db-reset'" — and exited 0, which this side reports as
    // "The assistant engine exited before it was ready". `make` is a developer target no
    // install ships, so there was no way forward from inside the app.
    //
    // Asserted HERE rather than only in the engine's own suite because this is the seam
    // that broke: the reset machinery worked throughout, and what was missing was the
    // host passing the hooks. Only booting the real binary from this side shows that.
    const shared = await mkdtemp(path.join(tmpdir(), "daintree-engine-stale-"));
    try {
      // Boot once so the engine writes a REAL database at the CURRENT baseline. Built
      // by the engine rather than hand-rolled here: a synthetic SQLite file is rejected
      // as malformed long before the version check this test is about.
      await driveEngine(binary!, "ses_seed", { stateDir: shared });

      // Age it. `user_version` is a big-endian u32 at offset 60 of the 100-byte header,
      // so one four-byte write turns a current database into a legacy one without
      // needing a driver or knowing anything about the schema itself.
      const dbPath = path.join(shared, "state.db");
      const handle = await open(dbPath, "r+");
      try {
        await handle.write(Buffer.from([0, 0, 0, 1]), 0, 4, 60);
      } finally {
        await handle.close();
      }

      const { frames, exitCode } = await driveEngine(binary!, "ses_stale", { stateDir: shared });
      const parsed = frames.map(parseAssistantHostEvent);

      const refusal = parsed.find((e) => e?.type === "host:error");
      expect(
        refusal,
        `the engine refused to boot instead of recovering: ${JSON.stringify(refusal)}`
      ).toBeUndefined();
      expect(
        parsed.find((e) => e?.type === "host:ready"),
        "the engine never became ready on a legacy state directory"
      ).toBeDefined();
      expect(exitCode).toBe(0);

      // Recovered, not discarded: the previous database is moved aside, so a user's
      // timers, watchers, memories and history survive an upgrade they did not ask for.
      const backups = (await readdir(shared)).filter((n) => n.startsWith("state.db.bak-v"));
      expect(backups, "the old database was not preserved").toHaveLength(1);
    } finally {
      await rm(shared, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 60_000);

  it("keeps diagnostics off the protocol stream", async () => {
    // The engine reports a degraded MCP connection on a run like this. It must arrive
    // on stderr: a diagnostic on stdout would be an unparseable frame, and the
    // renderer would drop a real event trying to make sense of it.
    const { frames, stderr } = await driveEngine(binary!, "ses_streams");

    expect(stderr).toContain("MCP");
    for (const frame of frames) {
      expect(frame).toHaveProperty("type");
      expect(frame).toHaveProperty("seq");
    }
  }, 40_000);
});

/**
 * The engine advertises the account commands, so the panel can offer them.
 *
 * This is the cross-repo half of sign-in, and it is the one that can rot silently.
 * Daintree renders its slash palette from the catalog the engine hands over in
 * `host:ready` — it keeps no list of its own, deliberately, so that the two cannot
 * drift. The consequence is that `/login` working in the panel is entirely a claim
 * about the ENGINE, and nothing in Daintree's own tree can verify it.
 *
 * The failure this guards is concrete and was real until the engine gained these
 * commands: Daintree removed its Settings account surface on the understanding that
 * sign-in had moved into the session, while a `/login` typed into the panel took the
 * unknown-command path and came back as "/login isn't a command" — leaving an install
 * with no way to sign in at all, and a complete OAuth implementation sitting one
 * registry row out of reach.
 */
/**
 * A backend socket that accepts the connection and then never answers.
 *
 * The harness's default endpoint is a CLOSED loopback port, which is refused in well
 * under a millisecond. That is the right fixture for "a dependency that cannot answer",
 * and the wrong one for "while a command is still working": `/account` against a refused
 * port finishes about as fast as a command that does no I/O at all, so a test that sends
 * a shutdown behind it is racing a command that has already returned.
 *
 * Accepting and stalling is what makes an account command genuinely outstanding, and it
 * does it hermetically — no network, no billable work, identical on every platform.
 *
 * How long "outstanding" lasts was MEASURED against this binary rather than reasoned
 * from any one timeout, because `/account` is several requests and no single constant
 * bounds it: auth discovery runs first under its own 10s ceiling, is asked for more than
 * once, and the protected account read that follows carries the backend client's 60s
 * per-attempt ceiling. Driven against this fixture the command was still running after
 * 95 seconds, with the engine's own goroutine dump showing it inside the discovery
 * fetch. That is four times the harness's 25s kill, so nothing here comes back on its
 * own inside a run: whatever ends the command was serviced by the host loop.
 *
 * `requested` resolves with the first request line the engine writes, and `requestLine`
 * reads it back afterwards. That is what turns "the command was registered" into "the
 * command was on the network" — the host claims its busy flag before the worker
 * goroutine has done anything at all, so a frame alone cannot tell those apart.
 */
async function startStallingBackend(): Promise<{
  url: string;
  requested: Promise<string>;
  requestLine: () => string | null;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let firstRequestLine: string | null = null;
  let announceRequest: (line: string) => void = () => undefined;
  const requested = new Promise<string>((resolve) => {
    announceRequest = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    // Read and answer NOTHING. Reading matters anyway: it is how the fixture knows a
    // request was actually written rather than a connection merely opened, and a socket
    // whose buffer is never drained would eventually stall the writer for the wrong
    // reason.
    //
    // Buffered to the first CRLF rather than reported per chunk, because TCP chunk
    // boundaries are arbitrary: a request line split across two reads would otherwise be
    // announced as a fragment, and the caller would be matching half a line.
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (firstRequestLine !== null) return;
      pending += chunk;
      const end = pending.indexOf("\r\n");
      if (end === -1) return;
      firstRequestLine = pending.slice(0, end);
      announceRequest(firstRequestLine);
    });
    // A held socket is torn down from both ends — destroyed here, and dropped when the
    // engine exits or is killed. An unhandled `error` on a net.Socket is thrown, which
    // would take the whole vitest worker down over a reset the fixture expects.
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stalling backend did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requested,
    requestLine: () => firstRequestLine,
    // Destroy the held connections first: `close` only stops new ones, and a server
    // still holding the engine's stalled socket never fires its callback.
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe.skipIf(!binary)("assistant engine account commands", () => {
  it("advertises the sign-in commands in the ready catalog", async () => {
    const { frames, stderr } = await driveEngine(binary!, "ses_account_commands");
    const ready = frames.map(parseAssistantHostEvent).find((e) => e?.type === "host:ready") as
      { commands?: { name: string }[] } | undefined;

    expect(ready, `the engine never became ready.\n${stderr}`).toBeDefined();

    const names = (ready?.commands ?? []).map((c) => c.name);
    expect(
      names.length,
      "the engine advertised no commands at all — the panel's palette would be empty"
    ).toBeGreaterThan(0);

    // Asserted WITH the leading slash, because that is what the engine puts on the wire
    // and what the panel renders verbatim. Matching on the bare word would pass on a
    // catalog whose entries the panel cannot display as typed.
    //
    // `/backend` sits with the three sign-in commands rather than with `/status`: it is
    // the OTHER half of the same ownership move. Daintree removed its backend-URL
    // setting on the understanding that the endpoint became the engine's own business,
    // chosen in-session and remembered across restarts — so an engine that stopped
    // advertising it would leave an install signed in to an endpoint with no way to
    // change it, which is the same dead end `/login` going missing produced.
    for (const command of ["/login", "/logout", "/account", "/backend"]) {
      expect(
        names,
        `the engine does not advertise ${command}, so the panel cannot offer it — ` +
          `advertised: ${names.join(", ")}`
      ).toContain(command);
    }
  }, 40_000);

  it("answers an account command with a structured result, not prose in a turn", async () => {
    // What the panel does with a slash line: sends `{type:"command"}` and renders the
    // `command:result` it gets back. The distinction being pinned is that the answer
    // arrives as its OWN event with the command echoed on it — not as an assistant turn,
    // and not as text the host would have to interpret.
    //
    // The backend is unreachable here by construction (the harness pins
    // DAINTREE_BACKEND_URL at a dead loopback port), so this also covers the case the
    // account contract most needs to get right: a dependency that cannot answer must
    // come back as a typed result the host can render, never as a hang and never as
    // silence. Daintree renders whatever text this carries; it must not read it.
    const { frames, stderr } = await driveEngine(binary!, "ses_account_result", {
      commands: ["/account"],
    });
    const results = frames
      .map(parseAssistantHostEvent)
      .filter((e) => e?.type === "command:result") as {
      command: string;
      text: string;
      unknown?: boolean;
    }[];

    expect(results.length, `no command:result came back for /account.\n${stderr}`).toBe(1);
    expect(
      results[0].unknown,
      "the engine did not recognise /account, so the panel would have sent it as a prompt"
    ).toBeFalsy();
    expect(results[0].command).toBe("/account");
    expect(
      results[0].text.length,
      "an empty result renders as a blank line in the panel"
    ).toBeGreaterThan(0);
  }, 60_000);

  it("answers /logout on the command path when the backend is unreachable", async () => {
    // `/logout` is advertised in the ready catalog, and the catalog is the only place
    // Daintree learns it exists. Advertised-but-not-dispatchable is exactly the dead end
    // `/login` produced before the engine gained these commands, and it would be
    // invisible from this side — the panel would send the line, take the unknown-command
    // path, and report a command the same engine had just offered as one it does not have.
    //
    // Driven against the harness's unreachable default endpoint on purpose. Signing out
    // is LOCAL by design (`logoutText`, internal/commands/account.go), and the person
    // most likely to want rid of a credential is the one whose backend stopped
    // answering. What is pinned here is that the command still ANSWERS them — an engine
    // that parked sign-out on a round trip would leave the panel with nothing to render
    // at all, which shows up as a missing result rather than a disappointing one. The
    // text itself is the engine's to word, so nothing here reads it.
    const { frames, stderr, exitCode } = await driveEngine(binary!, "ses_logout_result", {
      commands: ["/logout"],
    });
    const results = frames
      .map(parseAssistantHostEvent)
      .filter((e) => e?.type === "command:result") as {
      command: string;
      text: string;
      unknown?: boolean;
    }[];

    expect(results.length, `no command:result came back for /logout.\n${stderr}`).toBe(1);
    expect(
      results[0].unknown,
      "the engine did not recognise /logout, so the panel would have sent it as a prompt"
    ).toBeFalsy();
    expect(results[0].command).toBe("/logout");
    expect(
      results[0].text.length,
      "an empty result renders as a blank line in the panel"
    ).toBeGreaterThan(0);
    expect(exitCode).toBe(0);
  }, 60_000);

  it("keeps servicing the host loop while a slow account command is still working", async () => {
    // The property `Slow` exists for (internal/commands/registry.go): `/login`,
    // `/logout` and `/account` can wait on a browser or a backend round trip, and the
    // embedded host runs commands on its command loop. Run inline, those minutes are
    // minutes in which the loop services no interrupt, no approval and no shutdown and
    // posts nothing — the panel freezes with no way out. The engine dispatches them to a
    // worker instead.
    //
    // So: send the command and the shutdown together, without waiting. A prompt, clean
    // exit is the assertion — a loop blocked on the command would sit until the harness
    // killed it, and the kill shows up as a null exit code.
    //
    // The stalling backend is what gives that assertion its teeth. Against the default
    // refused port the command answers in under a millisecond, so an exit code of 0
    // proves nothing about a command still in flight — it is compatible with a loop that
    // blocked and was simply never made to wait. Against a socket that never answers the
    // command runs for over 95 seconds (measured — see `startStallingBackend`), so a
    // loop that ran it inline would still be inside it when the harness kills at 25s,
    // and the kill reports a null exit code rather than 0.
    const backend = await startStallingBackend();
    try {
      const { exitCode, stderr } = await driveEngine(binary!, "ses_slow_command", {
        commands: ["/account"],
        awaitCommandResults: false,
        backendUrl: backend.url,
      });

      expect(exitCode, `the engine did not exit cleanly while a slow command ran.\n${stderr}`).toBe(
        0
      );
    } finally {
      await backend.close();
    }
  }, 60_000);

  it("services an interrupt while a slow account command is still in flight", async () => {
    // Stop is the user's only immediate way out of a slow account command, and it is the
    // half of that contract nothing drove from this side. `/login` waits five minutes on a
    // browser callback the user may simply abandon; `handleInterrupt` cancels the
    // in-flight command first and unconditionally (internal/host/loop.go) precisely so
    // the panel's Stop means something there. If that stopped working, the panel would
    // keep offering a control that does nothing and the session would stay wedged.
    //
    // Nothing here is a clock. Each step rules out one way the result could have arrived
    // without the engine having done the thing being claimed:
    //
    // 1. `/logout` arrives behind an unfinished `/account` and comes back REFUSED as
    //    `command-busy`. That refusal is emitted from the branch that found the first
    //    command still in flight, so it is the engine stating the condition rather than
    //    the test guessing at it — and it is only reachable if the loop dequeued the
    //    second command while the first was outstanding. Deterministic, not racy: the
    //    busy flag is claimed inline on the single-threaded command loop before the
    //    worker goroutine is spawned, so the second line cannot arrive ahead of it.
    // 2. The interrupt waits for the FIXTURE to see a request, not for that refusal.
    //    The refusal proves the command is registered; only the socket proves it is
    //    doing the work an interrupt has to reach into. Interrupting between those two
    //    would cancel a context before any I/O began.
    // 3. `/account` then answers, and nothing else in the run could have made it: this
    //    command runs for over 95 seconds against this fixture (measured — see
    //    `startStallingBackend`), and the harness kills at 25.
    // 4. Except teardown, which cancels an in-flight command before it seals the output
    //    stream, so a shutdown can carry a result out with it. The result's position
    //    ahead of the first shutdown request excludes that, and `backstopFired` says the
    //    run never limped to its timer to get there.
    //
    // The refused command contributes no result of its own, which is the second thing
    // the result list pins: a rejection and an answer must not look alike to the panel.
    const backend = await startStallingBackend();
    try {
      const { frames, exitCode, stderr, backstopFired, shutdownRequestedAtFrame } =
        await driveEngine(binary!, "ses_slow_interrupt", {
          commands: ["/account", "/logout"],
          backendUrl: backend.url,
          interruptWhen: backend.requested,
        });
      const parsed = frames.map(parseAssistantHostEvent);

      expect(
        parsed.find((e) => e?.type === "host:error" && e.code === "command-busy"),
        `the engine never refused the second account command, so nothing shows it was ` +
          `servicing the loop while the first was outstanding.\n${stderr}`
      ).toBeDefined();

      // Read back, never awaited. Awaiting a promise that only settles when the engine
      // makes a request means a run where it never does hangs the test to its own
      // timeout, and a timed-out test never reaches the `finally` that closes this
      // server.
      expect(
        backend.requestLine(),
        "the engine never reached the backend, so the interrupt did not land on a " +
          "command that was doing any work"
      ).toMatch(/^[A-Z]+ \/\S+ HTTP\//);

      expect(
        backstopFired,
        `the run reached its shutdown timer, so any result below is teardown's work ` +
          `rather than the interrupt's.\n${stderr}`
      ).toBe(false);

      const answered = parsed
        .filter((e) => e?.type === "command:result")
        .map((e) => (e as { command: string }).command);
      expect(
        answered,
        `the in-flight command was never stopped, so Stop does nothing for a user ` +
          `waiting on one.\n${stderr}`
      ).toEqual(["/account"]);

      expect(
        parsed.findIndex((e) => e?.type === "command:result"),
        `the result landed after a shutdown had been asked for, so teardown could have ` +
          `produced it rather than the interrupt.\n${stderr}`
      ).toBeLessThan(shutdownRequestedAtFrame ?? -1);

      expect(exitCode, `the engine did not exit cleanly after the interrupt.\n${stderr}`).toBe(0);
    } finally {
      await backend.close();
    }
  }, 60_000);
});
