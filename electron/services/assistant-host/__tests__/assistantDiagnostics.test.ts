import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * The readout that answers "which backend is this actually talking to".
 *
 * SELECTED and RESOLVED are different questions, and they came apart once already — the
 * account commands inherited the shell's endpoint while the engine was spawned with a
 * resolved one, so `auth status` could report a healthy account on one backend while
 * every turn ran against another. A diagnostics panel that reported only the setting
 * would have shown nothing wrong.
 */

const settings = { backendEnvironment: "local" as string };
vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => settings,
}));

let binaryResult: { path?: string; error?: string } = { path: "/fake/daintree-assistant" };
vi.mock("../resolveAssistantBinary.js", () => ({
  resolveAssistantBinary: () =>
    binaryResult.error
      ? Promise.reject(new Error(binaryResult.error))
      : Promise.resolve(binaryResult.path!),
}));

vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
      kill: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", "daintree-assistant 2.1.0\n");
      child.emit("close", 0);
    });
    return child;
  },
}));

let probeResult: unknown = { reachable: true, version: { serverVersion: "1.0.0" } };
vi.mock("../probeBackend.js", () => ({
  probeAssistantBackend: (origin: string) => {
    probedOrigins.push(origin);
    return Promise.resolve(probeResult);
  },
}));
const probedOrigins: string[] = [];

const { collectAssistantDiagnostics } = await import("../AssistantDiagnostics.js");

describe("collectAssistantDiagnostics", () => {
  beforeEach(() => {
    settings.backendEnvironment = "local";
    binaryResult = { path: "/fake/daintree-assistant" };
    probeResult = { reachable: true, version: { serverVersion: "1.0.0" } };
    probedOrigins.length = 0;
    delete process.env.DAINTREE_BACKEND_URL;
  });

  it("reports the origin it would actually spawn against, not just the setting", async () => {
    settings.backendEnvironment = "staging";
    const report = await collectAssistantDiagnostics();

    expect(report.environment.selected).toBe("staging");
    // Resolved through the same call the spawn uses, so the two cannot disagree.
    expect(report.environment.resolvedUrl).toBe("https://assistant.daintree.org");
    expect(probedOrigins).toEqual(["https://assistant.daintree.org"]);
  });

  it("says when an environment variable moved the endpoint", async () => {
    // "The variable moved it" and "the setting is wrong" send a reader to entirely
    // different places, so the readout has to distinguish them.
    process.env.DAINTREE_BACKEND_URL = "http://127.0.0.1:9999";
    const report = await collectAssistantDiagnostics();

    expect(report.environment.envOverride).toBe("applied");
    expect(report.environment.resolvedUrl).toContain("9999");
  });

  it("distinguishes a variable that was refused from one that applied", async () => {
    // The resolver declines an off-box value SILENTLY and falls back to the chosen
    // environment. Reporting that as "overridden" would explain the resolved origin by
    // pointing at the value that had nothing to do with it; reporting it as "none" would
    // leave a reader unable to explain why their export did nothing.
    settings.backendEnvironment = "local";
    process.env.DAINTREE_BACKEND_URL = "https://evil.example";
    const report = await collectAssistantDiagnostics();

    expect(report.environment.envOverride).toBe("refused");
    expect(report.environment.resolvedUrl).toBe("http://127.0.0.1:8473");
  });

  it("reports no override when there is none", async () => {
    const report = await collectAssistantDiagnostics();
    expect(report.environment.envOverride).toBe("none");
  });

  it("reports the engine build and this build's protocol version", async () => {
    const report = await collectAssistantDiagnostics();

    expect(report.engine).toMatchObject({
      found: true,
      binaryPath: "/fake/daintree-assistant",
      version: "daintree-assistant 2.1.0",
    });
    expect(report.hostProtocolVersion).toBeGreaterThan(0);
  });

  it("treats a missing engine as a diagnosis, not a failure of the diagnostic", async () => {
    binaryResult = { error: "Could not find the Daintree Assistant engine." };
    const report = await collectAssistantDiagnostics();

    expect(report.engine.found).toBe(false);
    expect(report.engine.found === false && report.engine.detail).toContain("Could not find");
    // The rest of the readout still arrives — the endpoint question is if anything more
    // urgent when the engine is missing.
    expect(report.environment.resolvedUrl).toBeTruthy();
  });

  it("carries the endpoint verdict through, including why it failed", async () => {
    probeResult = { reachable: false, code: "redirected", detail: "redirected to /login" };
    const report = await collectAssistantDiagnostics();

    expect(report.backend).toMatchObject({ reachable: false, code: "redirected" });
  });

  it("strips credentials a loopback override may legitimately carry", async () => {
    // `http://user:pass@127.0.0.1:8473` PASSES the loopback check — the parser reports
    // the hostname as 127.0.0.1 — and the engine needs those credentials. This readout
    // does not: it exists to be copied into a bug report.
    process.env.DAINTREE_BACKEND_URL = "http://user:sekret@127.0.0.1:8473/?token=abc";
    const report = await collectAssistantDiagnostics();

    expect(report.environment.resolvedUrl).not.toContain("sekret");
    expect(report.environment.resolvedUrl).not.toContain("abc");
    expect(report.environment.resolvedUrl).toContain("127.0.0.1:8473");
    // Said, not silently dropped — a reader chasing an auth failure needs to know the
    // endpoint has credentials on it.
    expect(report.environment.resolvedUrl).toContain("credentials hidden");
  });

  it("never reads Daintree's own secrets, whatever is in the environment", async () => {
    // Narrower than "the payload cannot carry a secret", which is not true — several
    // fields are free text produced by an engine or a remote server, and free text
    // belongs to whoever produced it. What IS true, and what this pins, is that nothing
    // here goes looking for a bearer or an MCP value.
    process.env.DAINTREE_MCP_TOKEN = "tok_should_never_appear";
    process.env.DAINTREE_MCP_URL = "http://127.0.0.1:1/mcp_should_never_appear";
    process.env.DAINTREE_API_KEY = "key_should_never_appear";
    try {
      const serialized = JSON.stringify(await collectAssistantDiagnostics());
      expect(serialized).not.toContain("tok_should_never_appear");
      expect(serialized).not.toContain("mcp_should_never_appear");
      expect(serialized).not.toContain("key_should_never_appear");
    } finally {
      delete process.env.DAINTREE_MCP_TOKEN;
      delete process.env.DAINTREE_MCP_URL;
      delete process.env.DAINTREE_API_KEY;
    }
  });

  it("coalesces concurrent reads into one", async () => {
    // Each read spawns a process and makes a network request, and the IPC behind it
    // takes no arguments — so a renderer in a loop, or an impatient double-click, would
    // otherwise multiply both. Disabling a button is a courtesy, not a bound.
    probedOrigins.length = 0;
    const [a, b, c] = await Promise.all([
      collectAssistantDiagnostics(),
      collectAssistantDiagnostics(),
      collectAssistantDiagnostics(),
    ]);

    expect(probedOrigins).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
