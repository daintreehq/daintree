import { describe, it, expect } from "vitest";
import { resolveBackendUrl } from "../resolveBackendUrl.js";
import {
  ASSISTANT_BACKEND_ENVIRONMENTS,
  SELECTABLE_ASSISTANT_BACKEND_ENVIRONMENTS,
  DEFAULT_ASSISTANT_BACKEND_ENVIRONMENT,
  assistantBackendEnvironment,
  canonicalAssistantBackendEnvironment,
  isAssistantBackendEnvironment,
  isSelectableAssistantBackendEnvironment,
} from "../../../../shared/config/assistantBackend.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The assistant engine must not reach a paid backend by ACCIDENT.
 *
 * The original form of this guard was absolute: no value could move the endpoint off
 * this machine, because the panel was pre-release and unauthenticated. Sign-in changed
 * that — a remote backend is now the point — so the guard changed shape rather than
 * going away.
 *
 * What it protects now is the distinction between a choice and an accident:
 *
 *   - A CHOICE, made in Settings, may select any environment we operate.
 *   - `DAINTREE_BACKEND_URL` may still only move the endpoint within loopback, because
 *     an inherited variable is exactly the accident this was written for. It is the one
 *     input that arrives from a shell exported months ago, a parent process, or a CI
 *     job nobody is looking at.
 *   - The DEFAULT, with neither of those, is still local. An install that has never
 *     been configured spends nobody's money.
 *
 * The source-level assertions are deliberate: the property is "this file always sets
 * the variable", and reading the source proves that without needing an engine binary, a
 * backend, or a live session.
 */

const SERVICE = path.resolve(__dirname, "../AssistantHostService.ts");
const source = readFileSync(SERVICE, "utf8");

const REMOTES = ASSISTANT_BACKEND_ENVIRONMENTS.filter((e) => e.remote);

describe("assistant backend pinning", () => {
  it("sets DAINTREE_BACKEND_URL on every spawn", () => {
    // Without this line the engine falls back to its OWN default, which is deployed —
    // so an unset variable would reach production rather than the local default.
    expect(source).toContain("DAINTREE_BACKEND_URL:");
  });

  it("resolves the endpoint through the shared resolver, not its own copy", () => {
    // Two resolvers is how the engine and the `auth` commands drifted apart in the
    // first place. There must be exactly one, and this file must use it.
    expect(source).toContain("resolveBackendUrl(");
    expect(source).not.toContain("const DEFAULT_BACKEND_URL");
  });

  it("defaults to a local endpoint with nothing configured", () => {
    const url = new URL(resolveBackendUrl(undefined, undefined));
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    expect(loopback, `the default points at ${url.hostname}, which is not loopback`).toBe(true);
  });

  it("keeps the shipped default environment local", () => {
    // The constant and the table have to agree; a default that named a remote would
    // move every unconfigured install onto it at once.
    expect(assistantBackendEnvironment(DEFAULT_ASSISTANT_BACKEND_ENVIRONMENT).remote).toBe(false);
  });

  describe("DAINTREE_BACKEND_URL", () => {
    it("moves the endpoint around inside loopback", () => {
      // Port, scheme and path are a developer's business — a second backend on another
      // port is a normal thing to run. Values come back in the URL parser's canonical
      // form, which is why the trailing slash appears.
      expect(resolveBackendUrl("http://localhost:9999")).toBe("http://localhost:9999/");
      expect(resolveBackendUrl("http://127.0.0.1:8474/api")).toBe("http://127.0.0.1:8474/api");
      expect(resolveBackendUrl("https://localhost:8473")).toBe("https://localhost:8473/");
      expect(resolveBackendUrl("http://[::1]:8473")).toBe("http://[::1]:8473/");
    });

    it("cannot reach off-box, not even an environment we operate", () => {
      // The asymmetry that is the whole point. A variable is set by accident constantly;
      // a settings picker is not. So the variable keeps its original ceiling even for
      // endpoints a CHOICE is allowed to select — otherwise a stray export would still
      // be able to start spending money.
      const offBox = [
        ...REMOTES.map((e) => e.url),
        "https://elsewhere.example.test",
        "http://192.168.1.50:8473",
        "http://evil.test:8473",
        // Not loopback: a bare hostname that merely CONTAINS one.
        "http://localhost.evil.test:8473",
      ];
      for (const remote of offBox) {
        expect(new URL(resolveBackendUrl(remote)).hostname, remote).toBe("127.0.0.1");
      }
    });

    it("falls back to the CHOSEN environment when refused, not to local", () => {
      // Someone on Staging who also has a stray variable exported should stay on
      // Staging. Dropping them to loopback would look like the setting being ignored.
      const staging = assistantBackendEnvironment("staging").url;
      expect(resolveBackendUrl("http://evil.test:8473", "staging")).toBe(staging);
      expect(resolveBackendUrl("not a url", "staging")).toBe(staging);
    });

    it("treats blank as absent rather than passing it through", () => {
      // The engine reads an empty value as unset and falls through to its own deployed
      // default, so forwarding "" would quietly undo the choice — on the one input a
      // shell most easily produces.
      for (const blank of ["", "   ", undefined]) {
        expect(resolveBackendUrl(blank, "local")).toBe(assistantBackendEnvironment("local").url);
      }
    });

    it("normalises the IPv4 shorthands rather than passing them through", () => {
      // WHATWG resolves these to 127.0.0.1; Go's net.ParseIP does not recognise the
      // decimal form at all, so the engine would call itself non-loopback and be free to
      // send the request through an inherited HTTP_PROXY. Handing on the canonical form
      // means both parsers see the same address.
      expect(new URL(resolveBackendUrl("http://2130706433:8473")).hostname).toBe("127.0.0.1");
      expect(new URL(resolveBackendUrl("http://0x7f000001:8473")).hostname).toBe("127.0.0.1");
    });

    it("reads the hostname the parser found, not the one the string suggests", () => {
      // `http://127.0.0.1@evil.test/` has hostname `evil.test` — userinfo, not a host.
      expect(new URL(resolveBackendUrl("http://127.0.0.1@evil.test/")).hostname).toBe("127.0.0.1");
    });
  });

  describe("a deliberate choice", () => {
    for (const env of ASSISTANT_BACKEND_ENVIRONMENTS) {
      it(`reaches ${env.label}`, () => {
        expect(resolveBackendUrl(undefined, env.id)).toBe(env.url);
      });
    }

    it("sends every remote over https", () => {
      // Prompts, file paths and commands travel on this. The CLI refuses a plaintext
      // remote anyway; naming it here means a table edit cannot quietly introduce one.
      for (const env of REMOTES) {
        expect(new URL(env.url).protocol, env.label).toBe("https:");
      }
    });

    it("never resolves to the website origin", () => {
      // `staging.daintree.org` is the marketing and account site. It serves none of
      // `/v1/daintree/*`, `/version` or `/readyz`, so an assistant pointed at it gets
      // HTML where JSON was expected — which surfaces as a parse failure rather than as
      // "wrong host", and is therefore worth naming here rather than diagnosing later.
      // Browser destinations come from the CLI's own validated manifest, not this table.
      for (const env of ASSISTANT_BACKEND_ENVIRONMENTS) {
        expect(new URL(env.url).hostname, env.label).not.toBe("staging.daintree.org");
      }
    });

    it("gives every selectable environment its own endpoint", () => {
      // Two options resolving to one URL is a picker that cannot mean what it says: the
      // choice reads as consequential and is not. A retired name keeps its row so a
      // stored value still resolves, but it stops being offered.
      const urls = SELECTABLE_ASSISTANT_BACKEND_ENVIRONMENTS.map((e) => e.url);
      // The non-empty check is not decoration: an empty list has no duplicates either,
      // so without it this passes for a table with nothing left to choose from.
      expect(urls.length).toBeGreaterThan(1);
      expect(new Set(urls).size).toBe(urls.length);
    });

    /**
     * The migration property, pinned against LITERALS rather than the table.
     *
     * "production" is a value sitting in real settings files today, and
     * `https://assistant.daintree.org` is the endpoint it has always meant. Written out
     * here because reading both sides from the table would compare it to itself: the
     * assertion would survive deleting the row (an empty loop passes) and survive
     * repointing it (both sides move together), which are precisely the two edits that
     * would move somebody's prompts without telling them.
     */
    it("still points a stored 'production' at the endpoint it has always meant", () => {
      expect(isAssistantBackendEnvironment("production")).toBe(true);
      expect(resolveBackendUrl(undefined, "production")).toBe("https://assistant.daintree.org");
      // Not offered any more — but canonicalised onto a live choice that resolves
      // identically, so the picker is never handed a value it has no option for.
      expect(isSelectableAssistantBackendEnvironment("production")).toBe(false);
      expect(canonicalAssistantBackendEnvironment("production")).toBe("staging");
      expect(resolveBackendUrl(undefined, "staging")).toBe("https://assistant.daintree.org");
    });

    it("falls back to the local default for an unrecognised environment", () => {
      // A hand-edited or downgraded settings file is the input here. It must not stop
      // the assistant launching, and it must not launch it somewhere remote.
      // @ts-expect-error deliberately outside the union — this is the corruption case.
      expect(resolveBackendUrl(undefined, "somewhere-else")).toBe(
        assistantBackendEnvironment(DEFAULT_ASSISTANT_BACKEND_ENVIRONMENT).url
      );
    });
  });
});
