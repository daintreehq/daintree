import { describe, it, expect, afterEach } from "vitest";

import { assistantChildEnv } from "../assistantChildEnv.js";

/**
 * The engine inherits Daintree's environment, minus the variables that decide what it
 * may do and where it sends what it is given.
 *
 * This is the whole of that guard now. Daintree used to also SET `DAINTREE_BACKEND_URL`
 * from a Settings picker, resolving it through a `resolveBackendUrl` that refused any
 * off-box value; the picker and the resolver both went when the endpoint became the
 * engine's own business, chosen with `/backend` and remembered across restarts. What
 * could not go with them is the strip: the threat it answers is an INHERITED value — one
 * exported in a shell months ago, set by a parent process, or left in a CI environment —
 * and the engine reads that variable as a pin from an embedding host, so a leaked one
 * would both repoint every prompt and disable the command that could move it back.
 */
describe("assistantChildEnv", () => {
  const added: string[] = [];

  function setEnv(name: string, value: string) {
    added.push(name);
    process.env[name] = value;
  }

  afterEach(() => {
    for (const name of added.splice(0)) delete process.env[name];
  });

  it("strips the variables that steer the engine, and keeps everything else", () => {
    setEnv("DAINTREE_BACKEND_URL", "https://somewhere-nobody-chose.test");
    setEnv("DAINTREE_API_KEY", "sk-inherited-from-a-shell-profile");
    setEnv("DAINTREE_ASSISTANT_AUTO_APPROVE", "1");
    setEnv("DAINTREE_ASSISTANT_TIER", "system");
    // An ordinary variable the engine legitimately needs: the strip must be a named
    // list, not a `DAINTREE_`-prefixed sweep.
    setEnv("DAINTREE_UNRELATED_PASSTHROUGH", "keep-me");

    const env = assistantChildEnv();

    expect(env.DAINTREE_BACKEND_URL).toBeUndefined();
    expect(env.DAINTREE_API_KEY).toBeUndefined();
    expect(env.DAINTREE_ASSISTANT_AUTO_APPROVE).toBeUndefined();
    expect(env.DAINTREE_ASSISTANT_TIER).toBeUndefined();
    expect(env.DAINTREE_UNRELATED_PASSTHROUGH).toBe("keep-me");
  });

  it("strips the rest of the engine's trusted surface, not just the endpoint and the key", () => {
    // These are the names the engine reads through `trustedGet` (internal/config/config.go)
    // — its own list of "the embedding host may set this, a bound repository may not".
    // Each was missing from the strip while the variable it partners was already in it,
    // which is the shape of the gap rather than an accident: the endpoint was guarded
    // while the switch authorizing an unsafe one was not, and the tier was guarded while
    // the directory deciding whose session it is was not.
    setEnv("DAINTREE_ALLOW_INSECURE_BACKEND", "1");
    setEnv("DAINTREE_ASSISTANT_STATE_DIR", "/tmp/somebody-elses-session");
    setEnv("DAINTREE_ASSISTANT_OFFLINE", "1");
    setEnv("DAINTREE_ROUTING_ONLY", "https://somewhere-nobody-chose.test");
    setEnv("DAINTREE_ROUTING_IGNORE", "https://the-one-we-wanted.test");
    setEnv("DAINTREE_ROUTING_PRIVACY", "none");
    setEnv("DAINTREE_ROUTING_SORT", "cost");

    const env = assistantChildEnv();

    expect(
      Object.keys(env).filter((k) => k.startsWith("DAINTREE_ROUTING_")),
      "routing policy is endpoint selection by another name — an inherited pair repoints " +
        "the conversation without touching the variable that names the backend"
    ).toEqual([]);
    expect(env.DAINTREE_ALLOW_INSECURE_BACKEND).toBeUndefined();
    expect(env.DAINTREE_ASSISTANT_STATE_DIR).toBeUndefined();
    expect(env.DAINTREE_ASSISTANT_OFFLINE).toBeUndefined();
  });

  it("strips the knobs the engine reads outside its own trust tiering", () => {
    // All but the last are read with a bare `os.Getenv` outside config resolution, so
    // they never pass `trustedGet` at all — the engine documents them as test-only or
    // operator-only, and nothing in it stops one arriving from a shell instead.
    // `SOCKET_DIR` is the load-bearing one: the embedded host has to find the supervisor
    // holding this project's owner lock over that socket before it can ask it to yield,
    // and pointed at the wrong root it waits the lease out and refuses to start.
    setEnv("DAINTREE_ASSISTANT_SOCKET_DIR", "/tmp/a-lease-nobody-can-see");
    setEnv("DAINTREE_ASSISTANT_NO_DAEMON", "1");
    setEnv("DAINTREE_ASSISTANT_DAEMON_FAST", "1");
    setEnv("DAINTREE_ASSISTANT_DAEMON_IDLE_EXIT_MS", "250");
    setEnv("DAINTREE_ASSISTANT_BOOT_TRACE", "/tmp/a-path-nobody-chose.trace");
    setEnv("DAINTREE_WORKFLOW_INTELLIGENCE", "0");

    const env = assistantChildEnv();

    expect(
      Object.keys(env).filter((k) => k.startsWith("DAINTREE_ASSISTANT_DAEMON_")),
      "the daemon's test cadences retire the supervisor mid-session"
    ).toEqual([]);
    expect(env.DAINTREE_ASSISTANT_SOCKET_DIR).toBeUndefined();
    expect(env.DAINTREE_ASSISTANT_NO_DAEMON).toBeUndefined();
    expect(env.DAINTREE_ASSISTANT_BOOT_TRACE).toBeUndefined();
    expect(env.DAINTREE_WORKFLOW_INTELLIGENCE).toBeUndefined();
  });

  it("leaves an ordinary environment intact", () => {
    // The strip is a named list, never a `DAINTREE_`-prefixed sweep and never a
    // reconstructed environment: the engine spawns tools and a shell, and an env missing
    // PATH or HOME fails in ways that look nothing like an environment problem.
    const env = assistantChildEnv();

    for (const name of ["PATH", "HOME", "SHELL", "TERM", "LANG"] as const) {
      if (process.env[name] === undefined) continue;
      expect(env[name], `${name} did not survive the filter`).toBe(process.env[name]);
    }
  });

  it("strips regardless of the casing the variable was exported under", () => {
    // Windows environment variables are case-insensitive, so a parent that exported a
    // lower-cased spelling reaches `process.env` under it — and the child then reads it
    // under any casing. An exact-match filter would keep it.
    setEnv("daintree_backend_url", "https://somewhere-nobody-chose.test");
    setEnv("Daintree_Assistant_Auto_Approve", "1");

    const env = assistantChildEnv();

    const survivors = Object.keys(env).filter((k) =>
      ["daintree_backend_url", "daintree_assistant_auto_approve"].includes(k.toLowerCase())
    );
    expect(survivors).toEqual([]);
  });
});
