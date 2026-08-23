import { describe, it, expect } from "vitest";
import { resolveBackendUrl } from "../AssistantHostService.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The assistant engine must not silently reach the DEPLOYED backend.
 *
 * The engine's own default endpoint is `https://assistant.daintree.org`. If Daintree
 * spawns it without setting `DAINTREE_BACKEND_URL`, an unconfigured dev machine — or a
 * CI run, or a test that forgot to isolate itself — talks to production and spends
 * real money on model calls. Nothing fails; a turn just quietly succeeds against the
 * wrong endpoint, which is the failure mode that costs money rather than time.
 *
 * These are source-level assertions rather than a spawn test on purpose: the property
 * being protected is "this file always sets the variable", and reading the source
 * proves that without needing an engine binary, a backend, or a live session.
 */

const SERVICE = path.resolve(__dirname, "../AssistantHostService.ts");
const source = readFileSync(SERVICE, "utf8");

/**
 * The source with comments removed.
 *
 * The file legitimately NAMES the deployed endpoint while explaining why it is not the
 * default, so a scan of the raw text would forbid the explanation along with the
 * behaviour. Stripping comments is also more honest than trying to detect string
 * literals with a regex: prose contains apostrophes, and "engine's" opens a quote that
 * never closes.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("assistant backend pinning", () => {
  it("sets DAINTREE_BACKEND_URL on every spawn", () => {
    // Without this line the engine falls back to its own default, which is deployed.
    expect(source).toContain("DAINTREE_BACKEND_URL:");
  });

  it("defaults to a loopback endpoint, never the deployed one", () => {
    const match = /const DEFAULT_BACKEND_URL = "([^"]+)"/.exec(source);
    expect(match, "DEFAULT_BACKEND_URL is no longer declared").not.toBeNull();

    const url = new URL(match![1]!);
    // Loopback by construction rather than by string match: `localhost`, `127.0.0.1`
    // and `[::1]` are all acceptable, and anything else is not.
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    expect(loopback, `DEFAULT_BACKEND_URL points at ${url.hostname}, which is not loopback`).toBe(
      true
    );
  });

  it("never uses the deployed backend as a value", () => {
    // Checked against the comment-stripped source — see `code` above.
    expect(code).not.toContain("assistant.daintree.org");
  });

  describe("resolveBackendUrl", () => {
    it("lets an override move the endpoint around inside loopback", () => {
      // Port, scheme and path are a developer's business — a second backend on another
      // port is a normal thing to run. Leaving the machine is not. Values come back in
      // the URL parser's canonical form, which is why the trailing slash appears.
      expect(resolveBackendUrl("http://localhost:9999")).toBe("http://localhost:9999/");
      expect(resolveBackendUrl("http://127.0.0.1:8474/api")).toBe("http://127.0.0.1:8474/api");
      expect(resolveBackendUrl("https://localhost:8473")).toBe("https://localhost:8473/");
      expect(resolveBackendUrl("http://[::1]:8473")).toBe("http://[::1]:8473/");
    });

    it("refuses an off-box override", () => {
      // The panel is pre-release and UNAUTHENTICATED: every prompt, path and command it
      // carries goes to whatever this names. A stray DAINTREE_BACKEND_URL exported in a
      // shell months ago, or inherited from a parent process, must not be able to route
      // that off-box without anyone touching this feature.
      for (const remote of [
        "https://assistant.daintree.org",
        "https://staging.example.test",
        "http://192.168.1.50:8473",
        "http://evil.test:8473",
        // Not loopback: a bare hostname that merely CONTAINS one.
        "http://localhost.evil.test:8473",
      ]) {
        expect(new URL(resolveBackendUrl(remote)).hostname).toBe("127.0.0.1");
      }
    });

    it("normalises the IPv4 shorthands rather than passing them through", () => {
      // These are all 127.0.0.1 written differently, and the URL parser resolves them
      // before the check runs — so they are accepted. But the CANONICAL form is what
      // gets handed on, because the engine is a second parser and Go's `net.ParseIP`
      // does not recognise the decimal or hex spelling as loopback. Passing the raw
      // string through meant a value this function had just approved as local could be
      // sent through an inherited HTTP_PROXY on the far side.
      expect(resolveBackendUrl("http://2130706433:8473")).toBe("http://127.0.0.1:8473/");
      expect(resolveBackendUrl("http://0x7f000001:8473")).toBe("http://127.0.0.1:8473/");
      // A second local backend on another 127/8 address is an ordinary setup.
      expect(resolveBackendUrl("http://127.0.0.2:8473")).toBe("http://127.0.0.2:8473/");
      // Same name, absolutely qualified.
      expect(new URL(resolveBackendUrl("http://localhost.:8473")).hostname).toBe("localhost.");
      // Case is the parser's business, not ours.
      expect(resolveBackendUrl("http://LOCALHOST:8473")).toBe("http://localhost:8473/");
    });

    it("is not fooled by a host that only looks like loopback", () => {
      // Userinfo is the oldest trick in this family: the loopback address here is a
      // USERNAME, and the request would go to evil.test. The URL parser puts it in the
      // right field, which is why the check reads `hostname` rather than the string.
      for (const spoof of [
        "http://127.0.0.1@evil.test/",
        "http://localhost@evil.test/",
        "http://localhost.evil.test:8473",
        "http://evil.test/?h=127.0.0.1",
        "http://evil.test/127.0.0.1",
        "http://evil.test#localhost",
        // Not in 127/8, whatever it reads like.
        "http://127.evil.test:8473",
        "http://1.2.3.4:8473",
      ]) {
        expect(new URL(resolveBackendUrl(spoof)).hostname, spoof).toBe("127.0.0.1");
      }
    });

    it("falls back to loopback when the variable is unset", () => {
      expect(new URL(resolveBackendUrl(undefined)).hostname).toBe("127.0.0.1");
    });

    it("treats a blank value as unset rather than forwarding it", () => {
      // The regression this exists for: `??` guards only null and undefined, so an
      // empty or whitespace value reached the engine, which reads empty as UNSET and
      // falls through to the stored preference and then to its deployed default. The
      // pin came undone on the one input a shell most easily produces.
      for (const blank of ["", "   ", "\t", "\n"]) {
        expect(new URL(resolveBackendUrl(blank)).hostname).toBe("127.0.0.1");
      }
    });

    it("falls back rather than forwarding an unparseable value", () => {
      // A typo is not a deliberate override, and passing it through lands the engine on
      // its own deployed default — the one outcome this pin exists to prevent.
      for (const junk of ["not a url", "127.0.0.1:8473", "://", "http://"]) {
        expect(new URL(resolveBackendUrl(junk)).hostname).toBe("127.0.0.1");
      }
    });

    it("trims surrounding whitespace off a real override", () => {
      expect(resolveBackendUrl("  http://localhost:9999  ")).toBe("http://localhost:9999/");
    });
  });

  it("sends no credential of its own, and strips an inherited one", () => {
    // There is no sign-in: the backend holds its own upstream credential and returns an
    // anonymous principal. Daintree must not start inventing one — a bearer minted here
    // would be spent against whatever account it belongs to, invisibly.
    expect(code).not.toContain("Authorization");

    // Nor may it PASS ONE THROUGH. `DAINTREE_API_KEY` is the engine's upstream bearer
    // (vendor/daintree-assistant/internal/config/config.go), and the only way it can be
    // set here is by inheritance from the shell that launched Electron. An inherited key
    // does not fail — it succeeds, billed to whoever it belongs to, with nothing on
    // screen to say the session stopped being anonymous.
    //
    // The earlier version of this test asserted the name was ABSENT from the file, and
    // passed for exactly the wrong reason: the key was never mentioned because it was
    // never removed.
    const stripped = /const ENGINE_CONTROLLED_ENV = \[([\s\S]*?)\] as const;/.exec(source);
    expect(stripped, "ENGINE_CONTROLLED_ENV is no longer declared").not.toBeNull();
    expect(stripped![1]).toContain("DAINTREE_API_KEY");
  });

  it("strips control variables case-insensitively", () => {
    // Windows environment variables are case-insensitive: a parent that exported
    // `daintree_assistant_auto_approve=1` reaches process.env under that spelling, an
    // exact-match filter keeps it, and the child reads it under any casing. The one
    // variable where that matters most is the one that turns off every confirmation.
    expect(code).toContain("toUpperCase()");
  });
});
