import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { AssistantAccountService } from "../AssistantAccountService.js";
import {
  ASSISTANT_BACKEND_ENVIRONMENTS,
  assistantBackendEnvironment,
  type AssistantBackendEnvironment,
} from "../../../../shared/config/assistantBackend.js";
import { ENGINE_CONTROLLED_ENV } from "../../assistant-host/assistantChildEnv.js";

/** A fake child process whose streams a test drives directly. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (e: string) => void };
    stderr: EventEmitter & { setEncoding: (e: string) => void };
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: string | null;
  };
  const mkStream = () => {
    const s = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
    s.setEncoding = () => {};
    return s;
  };
  child.stdout = mkStream();
  child.stderr = mkStream();
  // Node reports a reaped child through these. `kill()` on one returns FALSE — it does
  // not throw — so they are the only honest test for "is this already gone", and the
  // service reads them before arming anything.
  child.exitCode = null;
  child.signalCode = null;
  // Node returns FALSE — it does not throw — when the process is already reaped. That
  // return is exactly what made the old `try/catch` guard useless, so the fake models
  // it rather than always succeeding.
  child.kill = vi.fn(() => child.exitCode === null && child.signalCode === null);
  return child;
}

/** Builds a service whose spawn is scripted. */
function serviceWith(
  script: (args: string[], child: ReturnType<typeof fakeChild>) => void,
  environment?: AssistantBackendEnvironment
) {
  const spawned: { args: string[]; opts: unknown; child: ReturnType<typeof fakeChild> }[] = [];
  const svc = new AssistantAccountService({
    resolveBinary: async () => "/fake/daintree-assistant",
    // Injected so these never read the settings store — and so the environment can be
    // varied, which is the only way to prove the choice reaches the child.
    resolveEnvironment: () => environment ?? "local",
    spawnProcess: ((_bin: string, args: string[], opts: unknown) => {
      const child = fakeChild();
      spawned.push({ args, opts, child });
      queueMicrotask(() => {
        // The capability probe. Every auth call is gated on it, so the default fixture
        // answers as a CURRENT engine; the old-engine test overrides this.
        if (args[0] === "--help") {
          child.stdout.emit(
            "data",
            "  auth <action>       sign in, check your account, or sign out\n"
          );
          child.emit("close", 0);
          return;
        }
        script(args, child);
      });
      return child;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  });
  return { svc, spawned };
}

describe("AssistantAccountService", () => {
  it("reads a status document from the CLI's event stream", async () => {
    const { svc, spawned } = serviceWith((_args, child) => {
      child.stdout.emit(
        "data",
        JSON.stringify({
          v: 1,
          type: "auth:status",
          data: {
            state: "signed_in_active",
            authenticated: true,
            environment: "staging",
            email: "person@example.com",
            planId: "standard",
            storageTier: "keychain",
          },
        }) + "\n"
      );
      child.emit("close", 0);
    });

    const res = await svc.getStatus();
    expect(res.available).toBe(true);
    if (!res.available) return;
    expect(res.status.state).toBe("signed_in_active");
    expect(res.status.email).toBe("person@example.com");
    expect(res.status.planId).toBe("standard");
    // The CLI is asked for machine output, never human output. spawned[0] is the
    // capability probe, which every auth call is gated behind.
    expect(spawned[0]!.args).toEqual(["--help"]);
    expect(spawned.find((c) => c.args[0] === "auth")!.args).toEqual(["auth", "status", "--json"]);
  });

  // THE most important test in this file.
  //
  // An engine that predates the account commands does NOT fail on `auth status --json`.
  // The CLI routes a positional subcommand only when --json is absent, so with it the
  // words "auth status" become a PROMPT and the engine runs a real, billed model turn —
  // exiting 0. An earlier version of this test fabricated exit 2, testing a failure mode
  // that does not exist and passing while the service would have spent the user's money.
  //
  // The fixture below behaves the way the old binary actually does.
  it("refuses to invoke auth on an engine that would run it as a billed prompt", async () => {
    const invoked: string[][] = [];
    const svc = new AssistantAccountService({
      resolveBinary: async () => "/fake/old-engine",
      spawnProcess: ((_bin: string, args: string[]) => {
        const child = fakeChild();
        invoked.push(args);
        queueMicrotask(() => {
          if (args[0] === "--help") {
            // An OLD engine's help: no auth line anywhere in it.
            child.stdout.emit("data", "  doctor              check backend, MCP, project\n");
            child.stdout.emit("data", "  status              show supervisor health\n");
            child.emit("close", 0);
            return;
          }
          // What the old binary would really do: run it as a prompt and succeed.
          child.stdout.emit("data", '{"type":"assistant","text":"I cannot sign you in."}\n');
          child.emit("close", 0);
        });
        return child;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });

    const status = await svc.getStatus();
    expect(status.available).toBe(false);
    if (status.available) return;
    expect(status.reason).toBe("cli-too-old");

    // And the money question: `auth` must never have been invoked at all.
    expect(invoked.some((a) => a[0] === "auth")).toBe(false);

    // Logout is the worst of the three: on an old engine it would run a prompt, exit 0,
    // and be reported as a sign-out that never happened.
    const out = await svc.logout();
    expect(out.signedOut).toBe(false);
    expect(invoked.some((a) => a[0] === "auth")).toBe(false);
  });

  // The type claims no field can carry a credential. Nothing enforced that until now: a
  // browser_opened URL was forwarded verbatim, and OAuth puts state in the query string.
  it("strips query and fragment from every URL it forwards", async () => {
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      child.stdout.emit(
        "data",
        JSON.stringify({
          v: 1,
          type: "auth:browser_opened",
          url: "https://idp.example/authorize?client_id=x&state=SECRET-STATE#tok=SECRET-FRAG",
        }) + "\n"
      );
      child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:authenticated" }) + "\n");
      child.emit("close", 0);
    });
    const seen: unknown[] = [];
    await svc.login(7, (e) => seen.push(e));
    const rendered = JSON.stringify(seen);
    expect(rendered).not.toContain("SECRET-STATE");
    expect(rendered).not.toContain("SECRET-FRAG");
    expect(rendered).toContain("https://idp.example/authorize");
  });

  // Provider error text is attacker-influenced. Daintree renders its own copy keyed by
  // the stable code instead of passing prose through.
  it("renders its own error copy rather than the CLI's message", async () => {
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      child.stdout.emit(
        "data",
        JSON.stringify({
          v: 1,
          type: "auth:error",
          code: "auth_callback_port_in_use",
          message: "LEAKY-PROVIDER-TEXT",
        }) + "\n"
      );
      child.emit("close", 1);
    });
    const seen: { message?: string }[] = [];
    await svc.login(7, (e) => seen.push(e as { message?: string }));
    const rendered = JSON.stringify(seen);
    expect(rendered).not.toContain("LEAKY-PROVIDER-TEXT");
    expect(rendered).toContain("already in use");
  });

  // A future payload must be dropped, not cast into a union it does not belong to.
  it("drops a status whose version or state it does not understand", async () => {
    for (const line of [
      JSON.stringify({
        v: 99,
        type: "auth:status",
        data: { state: "signed_in_active", storageTier: "keychain" },
      }),
      JSON.stringify({
        v: 1,
        type: "auth:status",
        data: { state: "a_state_from_the_future", storageTier: "keychain" },
      }),
    ]) {
      const { svc } = serviceWith((args, child) => {
        if (args[0] !== "auth") return;
        child.stdout.emit("data", line + "\n");
        child.emit("close", 0);
      });
      const res = await svc.getStatus();
      expect(res.available).toBe(false);
    }
  });

  it("reports a missing binary as such", async () => {
    const svc = new AssistantAccountService({
      resolveBinary: async () => {
        throw new Error("engine not built");
      },
    });
    const res = await svc.getStatus();
    expect(res.available).toBe(false);
    if (res.available) return;
    expect(res.reason).toBe("cli-missing");
  });

  it("forwards validated login progress and resolves on success", async () => {
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      child.stdout.emit(
        "data",
        JSON.stringify({ v: 1, type: "auth:starting", environment: "staging" }) + "\n"
      );
      child.stdout.emit(
        "data",
        JSON.stringify({
          v: 1,
          type: "auth:waiting",
          data: { callback: "127.0.0.1:42813", timeoutSeconds: 300 },
        }) + "\n"
      );
      child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:authenticated" }) + "\n");
      child.emit("close", 0);
    });

    const seen: string[] = [];
    const res = await svc.login(7, (e) => seen.push(e.type));
    expect(res.signedIn).toBe(true);
    expect(seen).toEqual(["starting", "waiting", "authenticated"]);
  });

  // A malformed or future-versioned line must be DROPPED, not guessed at. Rendering a
  // payload whose meaning has changed is worse than rendering nothing.
  it("drops lines it cannot trust rather than rendering them", async () => {
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      child.stdout.emit("data", "not json at all\n");
      child.stdout.emit("data", JSON.stringify({ v: 99, type: "auth:starting" }) + "\n"); // future version
      child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:unheard_of" }) + "\n"); // unknown type
      child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:authenticated" }) + "\n");
      child.emit("close", 0);
    });

    const seen: string[] = [];
    const res = await svc.login(7, (e) => seen.push(e.type));
    expect(res.signedIn).toBe(true);
    expect(seen).toEqual(["authenticated"]);
  });

  it("treats a declined consent screen as a cancellation, not a failure", async () => {
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:cancelled" }) + "\n");
      child.emit("close", 0);
    });
    const res = await svc.login(7, () => {});
    expect(res.signedIn).toBe(false);
    if (res.signedIn) return;
    expect(res.cancelled).toBe(true);
  });

  // The CLI binds ONE fixed callback port, so two concurrent flows would leave the second
  // staring at a browser tab that can never complete.
  it("refuses a second concurrent login", async () => {
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      // Never closes: the first login stays in flight.
      void child;
    });
    const first = svc.login(7, () => {});
    // Let the first register itself.
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.isLoginInProgress()).toBe(true);

    const second = await svc.login(9, () => {});
    expect(second.signedIn).toBe(false);
    if (second.signedIn) return;
    expect(second.code).toBe("login_in_progress");
    void first;
  });

  // One window must not be able to cancel another's sign-in — and a cancellation must
  // REPORT as one. The earlier version never awaited the result, so the incorrect
  // "Sign-in did not complete" outcome passed.
  it("only lets the owning window cancel a login, and reports it as a cancellation", async () => {
    let loginChild: ReturnType<typeof fakeChild> | null = null;
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      loginChild = child;
      // Never closes on its own: only the cancel ends it.
    });
    const pending = svc.login(7, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(svc.cancelLogin(9)).toBe(false); // a different window
    expect(svc.cancelLogin(7)).toBe(true); // the owner
    // A real kill surfaces as a signal-only close with no "cancelled" event.
    loginChild!.emit("close", null);

    const res = await pending;
    expect(res.signedIn).toBe(false);
    if (res.signedIn) return;
    expect(res.cancelled).toBe(true);
  });

  // A window that goes away must take its sign-in with it, or the CLI keeps holding the
  // one fixed callback port for its full five minutes with nobody able to complete it.
  it("reaps a login whose window was destroyed", async () => {
    let loginChild: ReturnType<typeof fakeChild> | null = null;
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      loginChild = child;
    });
    void svc.login(7, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(svc.isLoginInProgress()).toBe(true);

    svc.disposeForWebContents(7);
    expect(loginChild!.kill).toHaveBeenCalled();
  });

  // stderr can carry the authorization URL on the --no-open path, and human diagnostics
  // otherwise. Neither belongs in a renderer.
  it("never forwards stderr content as progress", async () => {
    const { svc } = serviceWith((args, child) => {
      if (args[1] !== "login") return;
      child.stderr.emit(
        "data",
        "Open this URL to sign in: https://idp.example/authorize?state=SECRET\n"
      );
      child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:authenticated" }) + "\n");
      child.emit("close", 0);
    });

    const payloads: unknown[] = [];
    await svc.login(7, (e) => payloads.push(e));
    const rendered = JSON.stringify(payloads);
    expect(rendered).not.toContain("SECRET");
    expect(rendered).not.toContain("authorize");
  });

  // The whole premise of this service is that it never handles a credential. Nothing it
  // spawns may carry one either.
  it("passes no credential in argv or the environment", async () => {
    const { svc, spawned } = serviceWith((_args, child) => {
      child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:authenticated" }) + "\n");
      child.emit("close", 0);
    });
    await svc.login(7, () => {});
    const call = spawned.find((c) => c.args[0] === "auth")!;
    const argv = call.args.join(" ");
    for (const banned of ["token", "secret", "password", "bearer", "key"]) {
      expect(argv.toLowerCase()).not.toContain(banned);
    }
    // stdin is closed: there is no channel for a credential to arrive on either.
    expect((call.opts as { stdio?: unknown[] }).stdio?.[0]).toBe("ignore");
    // An `env` IS now constructed — the child has to be told which backend to
    // authenticate against, or it inherits the shell's and can disagree with the engine.
    //
    // So the property is no longer "there is no env" but the sharper one: the
    // constructed env is the inherited environment plus EXACTLY ONE key, and that key
    // is the backend URL. Asserting the difference rather than the absence keeps this a
    // real guard — a credential added here later shows up as a second key, and a
    // credential smuggled into an existing variable shows up as a changed value.
    const env = (call.opts as { env?: NodeJS.ProcessEnv }).env!;
    expect(env).toBeDefined();
    const added = Object.keys(env).filter((k) => process.env[k] !== env[k]);
    expect(added).toEqual(["DAINTREE_BACKEND_URL"]);
    for (const banned of ["token", "secret", "password", "bearer", "key"]) {
      expect(env.DAINTREE_BACKEND_URL!.toLowerCase()).not.toContain(banned);
    }
    // No shell, so a resolved path containing metacharacters is inert.
    expect((call.opts as { shell?: boolean }).shell).toBe(false);
  });

  /**
   * The reason this service constructs an env at all.
   *
   * Sign-in and turns are separate processes. When only the ENGINE was told which
   * backend to use, these commands inherited the shell's — so `auth status` could
   * report a healthy account on one backend while every turn ran against another, and
   * nothing on either side reported the mismatch. The user-visible shape of that bug is
   * the worst kind: it looks like it works.
   */
  describe("backend environment", () => {
    for (const env of ASSISTANT_BACKEND_ENVIRONMENTS) {
      it(`runs auth against ${env.label} when that is the choice`, async () => {
        const { svc, spawned } = serviceWith((_args, child) => {
          child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:authenticated" }) + "\n");
          child.emit("close", 0);
        }, env.id);
        await svc.login(7, () => {});
        const call = spawned.find((c) => c.args[0] === "auth")!;
        const spawnEnv = (call.opts as { env?: NodeJS.ProcessEnv }).env!;
        expect(spawnEnv.DAINTREE_BACKEND_URL).toBe(env.url);
      });
    }

    it("strips the inherited control variables the engine spawn strips", async () => {
      // The other half of the same divergence. The engine was carefully denied an
      // ambient `DAINTREE_API_KEY` — an upstream credential Daintree does not mint and
      // never sees — while these commands, whose whole job is reporting who you are
      // signed in as, inherited it along with everything else in `process.env`.
      //
      // Every name is checked, not just the interesting one: the list is the contract,
      // and a variable added to it later must be stripped here without anyone
      // remembering to update this test.
      const inherited: Record<string, string> = {};
      for (const name of ENGINE_CONTROLLED_ENV) inherited[name] = "inherited-value";
      // Windows environment names are case-INSENSITIVE, so a parent exporting a lower-
      // case spelling reaches `process.env` under that key. An exact-match filter keeps
      // it and the child then reads it under any casing — which is why the strip
      // upper-cases before comparing, and why one lower-case name is planted here.
      inherited["daintree_api_key"] = "inherited-lowercase";
      const restore = { ...process.env };
      Object.assign(process.env, inherited);
      try {
        const { svc, spawned } = serviceWith((_args, child) => {
          child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:authenticated" }) + "\n");
          child.emit("close", 0);
        }, "local");
        await svc.login(7, () => {});
        const call = spawned.find((c) => c.args[0] === "auth")!;
        const spawnEnv = (call.opts as { env?: NodeJS.ProcessEnv }).env!;
        for (const name of ENGINE_CONTROLLED_ENV) {
          if (name === "DAINTREE_BACKEND_URL") {
            // Stripped and then RE-SET from the resolver, which is the point of the
            // ordering: the inherited value never survives beside the resolved one.
            expect(spawnEnv[name]).toBe(assistantBackendEnvironment("local").url);
            continue;
          }
          expect(spawnEnv[name], name).toBeUndefined();
        }
        // Named explicitly as well as covered by the loop above. The loop reads the
        // implementation's own list, so deleting an entry from it would make the loop
        // silently stop checking that entry — and this is the one whose absence is the
        // security property: an inherited upstream key does not fail, it SUCCEEDS, and
        // every turn is billed to whoever owns it with nothing on screen to say so.
        expect(spawnEnv.DAINTREE_API_KEY).toBeUndefined();
        expect(spawnEnv["daintree_api_key"]).toBeUndefined();
        // Still a usable environment — this strips a named list, it does not start from
        // empty. A child with no PATH cannot find anything it needs to run.
        expect(spawnEnv.PATH ?? spawnEnv.Path).toBeDefined();
      } finally {
        for (const name of [...ENGINE_CONTROLLED_ENV, "daintree_api_key"]) {
          if (restore[name] === undefined) delete process.env[name];
          else process.env[name] = restore[name];
        }
      }
    });

    it("tells the STATUS command the same thing it tells login", async () => {
      // Two commands, one answer. A status read against a different backend than the
      // login is precisely the divergence this exists to close.
      const { svc, spawned } = serviceWith((_args, child) => {
        child.stdout.emit(
          "data",
          JSON.stringify({
            v: 1,
            type: "auth:status",
            data: { state: "signed_out", storageTier: "keychain" },
          }) + "\n"
        );
        child.emit("close", 0);
      }, "staging");
      await svc.getStatus({});
      const call = spawned.find((c) => c.args[0] === "auth" && c.args[1] === "status")!;
      const spawnEnv = (call.opts as { env?: NodeJS.ProcessEnv }).env!;
      expect(spawnEnv.DAINTREE_BACKEND_URL).toBe(assistantBackendEnvironment("staging").url);
    });
  });

  // #6020: the IPC envelope auto-wraps a handler return in {ok:true,data}, so a payload
  // carrying its own `ok` would nest a failure inside a success. The discriminants here
  // are deliberately named otherwise, and this pins that.
  it("uses no discriminant the IPC envelope reserves", async () => {
    const { svc } = serviceWith((_args, child) => {
      child.stdout.emit(
        "data",
        JSON.stringify({
          v: 1,
          type: "auth:status",
          data: { state: "signed_out", storageTier: "keychain" },
        }) + "\n"
      );
      child.emit("close", 3);
    });
    const status = await svc.getStatus();
    for (const reserved of ["ok", "success"]) {
      expect(Object.keys(status)).not.toContain(reserved);
    }
    const out = await svc.logout();
    for (const reserved of ["ok", "success"]) {
      expect(Object.keys(out)).not.toContain(reserved);
    }
  });

  /**
   * The login child, and the ways it used to be left behind.
   *
   * `disposeForWebContents` existed with no caller at all, and there was nothing for
   * app shutdown to call — so a sign-in outlived the window that asked for it: the CLI
   * sat waiting on a browser callback for its full five-minute timeout, holding the ONE
   * fixed port it binds, and the next window's sign-in collided with a flow nobody
   * could see or complete.
   */
  describe("login child cleanup", () => {
    /** Starts a login and hands back its child, without letting it settle. */
    function startLogin(webContentsId = 7) {
      const { svc, spawned } = serviceWith(() => {
        // Deliberately silent — the CLI is waiting on the browser, which is exactly the
        // state these tests are about.
      });
      const result = svc.login(webContentsId, () => {});
      return { svc, spawned, result };
    }

    const loginChild = (spawned: ReturnType<typeof startLogin>["spawned"]) =>
      spawned.find((c) => c.args[0] === "auth")!.child;

    it("reaps a sign-in whose owning view has gone", async () => {
      const { svc, spawned, result } = startLogin(7);
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));

      svc.disposeForWebContents(7);

      expect(loginChild(spawned).kill).toHaveBeenCalledWith("SIGTERM");
      loginChild(spawned).emit("close", null);
      await expect(result).resolves.toMatchObject({ signedIn: false, cancelled: true });
    });

    it("leaves another view's sign-in alone", async () => {
      const { svc, spawned, result } = startLogin(7);
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));

      svc.disposeForWebContents(99);

      expect(loginChild(spawned).kill).not.toHaveBeenCalled();
      loginChild(spawned).emit("close", 1);
      await result;
    });

    it("treats a signal-killed child as gone too", async () => {
      // The other half of "already exited". A child reaped by a signal reports
      // `signalCode`, not `exitCode`, and reading only one of them would arm a backstop
      // for a process that is not there.
      const { svc, spawned, result } = startLogin(7);
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));
      const child = loginChild(spawned);
      child.signalCode = "SIGKILL";

      svc.disposeForWebContents(7);

      expect(child.kill).not.toHaveBeenCalled();
      child.emit("close", null);
      await result;
    });

    it("reaps whoever owns the sign-in at shutdown", async () => {
      const { svc, spawned, result } = startLogin(7);
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));

      svc.disposeAll();

      expect(loginChild(spawned).kill).toHaveBeenCalledWith("SIGTERM");
      loginChild(spawned).emit("close", null);
      await result;
    });

    it("waits for the child to go before letting shutdown finish", async () => {
      // `disposeAll` only ASKS: it sends SIGTERM and arms an unref'd SIGKILL backstop,
      // which `app.exit()` takes with it. The escalation has to happen while this
      // process is still here to escalate — so shutdown waits.
      const { svc, spawned, result } = startLogin(7);
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));
      const child = loginChild(spawned);

      let settled = false;
      const done = svc.shutdown(50).then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(settled).toBe(false);

      child.emit("close", null);
      await done;
      expect(settled).toBe(true);
      await result;
    });

    it("escalates to SIGKILL when a child ignores the request", async () => {
      // A CLI blocked in a syscall does not answer SIGTERM. Left there, it keeps the
      // callback port and the next install's sign-in cannot complete.
      const { svc, spawned, result } = startLogin(7);
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));
      const child = loginChild(spawned);

      const done = svc.shutdown(10);
      await new Promise((r) => setTimeout(r, 40));

      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await done;
      child.emit("close", null);
      await result;
    });

    it("reaps a status command still running at shutdown", async () => {
      // Not only the login. `auth status --refresh` is allowed 150 seconds, and a quit
      // landing inside one leaves a process talking to a backend for an app that has
      // gone. The login is the one that hurts, but the rule has no exceptions.
      const { svc, spawned } = serviceWith(() => {
        // Never answers — the shape of a status read against an unreachable backend.
      });
      const status = svc.getStatus();
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));
      const child = spawned.find((c) => c.args[0] === "auth")!.child;

      const done = svc.shutdown(10);
      await new Promise((r) => setTimeout(r, 40));

      expect(child.kill).toHaveBeenCalled();
      await done;
      child.emit("close", null);
      await status;
    });

    it("does not signal a child that has already exited", async () => {
      // The window between a child ACTUALLY exiting and Node dispatching its `close`.
      // The login slot is still held — `close` is what releases it — so a cancel or a
      // window closing in that gap reaches termination with a reaped process.
      //
      // `kill()` on a reaped process returns false rather than throwing, so the old
      // try/catch never noticed and armed its backstop anyway: a redundant signal, plus
      // a referenced three-second timer sitting on the event loop for a process that had
      // already gone, waiting on a `close` that may take its own time to arrive behind
      // delayed stdio. `child.killed` is not the test for this — it means a signal was
      // sent, not that anything exited — which is why the exit fields are read instead.
      const { svc, spawned, result } = startLogin(7);
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));
      const child = loginChild(spawned);
      const listenersBefore = child.listenerCount("close");
      // Exited, but `close` has not been dispatched yet.
      child.exitCode = 0;

      svc.disposeForWebContents(7);

      expect(child.kill).not.toHaveBeenCalled();
      // And nothing was armed: no extra listener, so no timer waiting to be cleared by
      // an event that has already been and gone.
      expect(child.listenerCount("close")).toBe(listenersBefore);

      child.emit("close", 0);
      await result;
    });

    it("signals once however many times cleanup is asked for", async () => {
      // Cancel racing the timeout, or a view loss racing a window close. Each extra
      // pass used to stack another timer and another `close` listener on one child.
      const { svc, spawned, result } = startLogin(7);
      await vi.waitFor(() => expect(spawned.some((c) => c.args[0] === "auth")).toBe(true));
      const child = loginChild(spawned);
      const listenersBefore = child.listenerCount("close");

      svc.cancelLogin(7);
      svc.disposeForWebContents(7);
      svc.disposeAll();

      expect(child.kill).toHaveBeenCalledTimes(1);
      // Baseline-relative rather than a magic ceiling: what matters is that repeated
      // cleanup adds at most ONE listener (and therefore at most one kill timer), not
      // that the total happens to be some particular number today.
      expect(child.listenerCount("close")).toBeLessThanOrEqual(listenersBefore + 1);
      child.emit("close", null);
      await result;
    });
  });

  /**
   * A backend with no account layer is a WORKING backend.
   *
   * The CLI says so and exits zero — `auth:not_offered` — but Daintree had no case for
   * the event, so the attempt fell through to the generic close handler and reported
   * "Sign-in did not complete." That is a fault, and there was no fault: the deployment
   * serves everyone anonymously and the assistant works. It landed on the shipped LOCAL
   * default, which is exactly the backend most likely to have no accounts.
   */
  describe("a backend without accounts", () => {
    it("reports it as an answer, not as a failed sign-in", async () => {
      const { svc } = serviceWith((_args, child) => {
        child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:not_offered" }) + "\n");
        // ZERO. The CLI is not reporting a problem.
        child.emit("close", 0);
      });

      const res = await svc.login(7, () => {});

      expect(res).toMatchObject({ signedIn: false, cancelled: false });
      // A stable code the renderer can branch on, not prose it has to match.
      expect(res.signedIn === false && res.code).toBe("auth_accounts_unavailable");
      expect(res.signedIn === false && res.message).not.toMatch(/did not complete/i);
    });

    it("still reports a failure when the run also failed", async () => {
      // The event alone is not the condition. A run that announced no accounts and then
      // fell over for some other reason IS a failure, and reporting it as
      // nothing-to-do-here would swallow the real one.
      const { svc } = serviceWith((_args, child) => {
        child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:not_offered" }) + "\n");
        child.emit("close", 1);
      });

      const res = await svc.login(7, () => {});

      expect(res.signedIn === false && res.code).not.toBe("auth_accounts_unavailable");
    });

    it("forwards it to the caller as its own progress event", async () => {
      // Typed rather than dropped: an event the parser has no case for is discarded, and
      // discarding this one is how the outcome above became indistinguishable from a
      // failure in the first place.
      const seen: string[] = [];
      const { svc } = serviceWith((_args, child) => {
        child.stdout.emit("data", JSON.stringify({ v: 1, type: "auth:not_offered" }) + "\n");
        child.emit("close", 0);
      });

      await svc.login(7, (event) => seen.push(event.type));

      expect(seen).toContain("not_offered");
    });
  });

  it("reports a logout failure rather than claiming success", async () => {
    const { svc } = serviceWith((_args, child) => child.emit("close", 1));
    const res = await svc.logout();
    expect(res.signedOut).toBe(false);
  });

  it("signs out successfully on a clean exit", async () => {
    const { svc, spawned } = serviceWith((_args, child) => child.emit("close", 0));
    const res = await svc.logout();
    expect(res.signedOut).toBe(true);
    expect(spawned.find((c) => c.args[0] === "auth")!.args).toEqual(["auth", "logout", "--json"]);
  });

  /**
   * An explicit refresh must actually reach the CLI.
   *
   * This is the flag the post-checkout wait depends on. Without it the CLI keeps
   * answering from the state it had before the purchase, so the UI would poll a stale
   * answer until it timed out and then tell the user their payment had not registered.
   */
  it("passes --refresh through when a live re-check is asked for", async () => {
    const { svc, spawned } = serviceWith((_args, child) => {
      child.stdout.emit(
        "data",
        JSON.stringify({
          v: 1,
          type: "auth:status",
          data: { state: "signed_in_active", storageTier: "keychain" },
        }) + "\n"
      );
      child.emit("close", 0);
    });
    await svc.getStatus({ refresh: true });
    const call = spawned.find((c) => c.args[0] === "auth")!;
    expect(call.args).toEqual(["auth", "status", "--json", "--refresh"]);
  });

  /**
   * A refresh reaches the network, so it must not be killed at the local-read deadline.
   *
   * Asserted as a RELATIONSHIP rather than against a literal: the point is that the
   * remote call gets more room than the disk read, not that either equals a particular
   * number, and pinning the numbers here would just duplicate the source.
   */
  it("gives a refreshing read a longer deadline than a cached one", async () => {
    // Each deadline is attributed to the call that armed it, so the capability probe's
    // own timeout cannot stand in for a status deadline. Taking a bare min/max across
    // every timer would let this pass even if BOTH status reads used the long bound,
    // because the 10s `--help` probe would supply the smaller number.
    const armed: Array<{ args: string[]; ms: number }> = [];
    const spawnedArgs: string[][] = [];

    const svc = new AssistantAccountService({
      resolveBinary: async () => "/fake/daintree-assistant",
      spawnProcess: ((_bin: string, args: string[]) => {
        const child = fakeChild();
        spawnedArgs.push(args);
        const realSetTimeout = globalThis.setTimeout;
        const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
          fn: () => void,
          ms?: number
        ) => {
          if (typeof ms === "number" && ms > 0) armed.push({ args, ms });
          spy.mockRestore();
          return realSetTimeout(fn, ms);
        }) as typeof globalThis.setTimeout);
        queueMicrotask(() => {
          if (args[0] === "--help") {
            child.stdout.emit("data", "  auth <action>       sign in\n");
            child.emit("close", 0);
          }
          // A status call never settles: the deadline is the only thing under test.
        });
        return child;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });

    void svc.getStatus();
    await Promise.resolve();
    await Promise.resolve();
    void svc.getStatus({ refresh: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const cached = armed.find((a) => a.args.join(" ") === "auth status --json");
    const refreshed = armed.find((a) => a.args.join(" ") === "auth status --json --refresh");
    expect(
      cached,
      `no deadline armed for a cached read; saw ${JSON.stringify(spawnedArgs)}`
    ).toBeDefined();
    expect(
      refreshed,
      `no deadline armed for a refreshing read; saw ${JSON.stringify(spawnedArgs)}`
    ).toBeDefined();
    // The refresh reaches the network and can rotate a one-time-use credential, so it
    // must not be cut off at the local-read deadline.
    expect(refreshed!.ms).toBeGreaterThan(cached!.ms);
  });
});
