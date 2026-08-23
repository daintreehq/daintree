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
    it("lets an explicit override win", () => {
      // Pointing at a staging or deployed backend on purpose is legitimate; the rule is
      // only that it has to be DELIBERATE. A pin with no escape hatch would push people
      // to edit the constant locally and commit it by accident.
      expect(resolveBackendUrl("https://staging.example.test")).toBe(
        "https://staging.example.test"
      );
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

    it("trims surrounding whitespace off a real override", () => {
      expect(resolveBackendUrl("  https://staging.example.test  ")).toBe(
        "https://staging.example.test"
      );
    });
  });

  it("sends no credential of its own", () => {
    // There is no sign-in: the backend holds its own upstream credential and returns an
    // anonymous principal. Daintree must not start inventing one — a bearer minted here
    // would be spent against whatever account it belongs to, invisibly.
    expect(code).not.toContain("DAINTREE_API_KEY");
    expect(code).not.toContain("Authorization");
  });
});
