import { describe, it, expect } from "vitest";

import { parseAssistantHostEvent, ASSISTANT_HOST_PROTOCOL_VERSION } from "../../../schemas/ipc.js";
import { engineTierFor } from "../AssistantHostService.js";
import { binary, driveEngine } from "./engineHarness.js";

/**
 * The tier binding, against the REAL engine.
 *
 * This suite exists because of a bug the fake engine could not have caught and did not:
 * `AssistantHostService` derived the session tier twice — once for the descriptor and
 * once for `DAINTREE_ASSISTANT_TIER` — from two different sources with two different
 * defaults. The real engine cross-checks the pair and treats a disagreement as fatal,
 * so a default install (`action`, mapping to `operator`, against a descriptor that said
 * `system`) could not start the native assistant at all. Every launch died on
 * `binding-mismatch` before reaching ready.
 *
 * The fake engine ignores the invariant entirely, which is exactly why it stayed
 * invisible: every renderer-level test passed throughout. So these assertions run the
 * vendored binary, and they assert the two directions that matter — that each shipped
 * tier boots, and that a deliberate mismatch is still REFUSED. The second half is not
 * decoration: the value of a fail-closed check is that it fails, and a test that only
 * proved the happy path would go on passing if the engine ever stopped checking.
 */

/**
 * Every tier Daintree's settings can be in, with the engine value it must produce.
 *
 * Written out rather than derived from `engineTierFor`, deliberately: the point is the
 * cross-repo agreement, and a table generated from the mapping under test could only
 * ever prove the mapping agrees with itself. `action` is called out because it is the
 * shipped default — the one that was broken.
 */
const TIERS = [
  { help: "workbench", engine: "supervisor" },
  { help: "action", engine: "operator" },
  { help: "system", engine: "system" },
] as const;

describe.skipIf(!binary)("assistant engine tier binding", () => {
  for (const { help, engine } of TIERS) {
    it(`boots at the ${help} setting, bound to ${engine}`, async () => {
      // The engine is driven with the INDEPENDENT value from the table, and the mapping
      // is asserted against it separately. Driving it with `engineTierFor(help)` on both
      // sides would have made this a smoke test and nothing more: a mapping that sent
      // all three settings to `system` would boot three identical sessions and pass.
      expect(engineTierFor(help)).toBe(engine);

      const { frames, stderr, exitCode } = await driveEngine(binary!, `ses_tier_${help}`, {
        descriptorTier: engine,
        environmentTier: engine,
      });
      const parsed = frames.map(parseAssistantHostEvent);

      const refusal = parsed.find((e) => e?.type === "host:error");
      expect(
        refusal,
        `the engine refused a ${help} session: ${JSON.stringify(refusal)}\n${stderr}`
      ).toBeUndefined();
      expect(
        parsed.find((e) => e?.type === "host:ready"),
        `the engine never became ready at the ${help} setting.\n${stderr}`
      ).toBeDefined();
      expect(exitCode).toBe(0);
    }, 40_000);
  }

  it("refuses a descriptor whose tier disagrees with the environment", async () => {
    // The exact shape of the shipped bug: the descriptor claims the widest tier while
    // the environment binds the runtime to a narrower one.
    const { frames, stderr, exitCode } = await driveEngine(binary!, "ses_tier_mismatch", {
      descriptorTier: "system",
      environmentTier: "operator",
    });
    const parsed = frames.map(parseAssistantHostEvent);

    const refusal = parsed.find((e) => e?.type === "host:error");
    expect(
      refusal,
      `the engine ACCEPTED a mismatched tier binding — the fail-closed check is gone.\n${stderr}`
    ).toBeDefined();
    expect(refusal).toMatchObject({ code: "binding-mismatch" });
    // `binding-mismatch` also covers projectId and windowId, and the harness states both
    // on both sides — so naming the FIELD is what makes this a test of the tier rather
    // than of whichever binding happened to disagree first.
    expect((refusal as { message?: string } | undefined)?.message).toContain("tier");
    expect(
      parsed.find((e) => e?.type === "host:ready"),
      "the engine became ready despite a mismatched binding"
    ).toBeUndefined();
    // A refusal EXITS. Without this the engine could emit the error, hang, and be
    // SIGKILLed by the harness backstop 25 seconds later, and this would still pass.
    expect(exitCode).toBe(1);
  }, 40_000);
});

/**
 * The version/protocol handshake, against the real binary.
 *
 * A smoke test in the literal sense: it proves the engine Daintree would spawn exists,
 * runs, agrees on the protocol version, and stops cleanly. That is the half of a
 * "staging-grade" check makeable here — a live probe of a remote backend is a network
 * test, and belongs behind an explicit opt-in rather than in a unit run.
 */
describe.skipIf(!binary)("assistant engine smoke", () => {
  it("starts, agrees on the protocol, and stops cleanly", async () => {
    const { frames, stderr, exitCode } = await driveEngine(binary!, "ses_smoke");
    const parsed = frames.map(parseAssistantHostEvent);

    const ready = parsed.find((e) => e?.type === "host:ready");
    expect(ready, `engine never became ready.\n${stderr}`).toBeDefined();
    // The two constants that must not drift: a disagreement is refused at the
    // handshake, so every session would fail with nothing else to look at.
    expect(ready).toMatchObject({ protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION });
    // It reports its own build, which is what a diagnostics readout quotes back.
    expect((ready as { version?: string } | undefined)?.version ?? "").not.toBe("");
    // Stopped, not killed by the harness backstop.
    expect(exitCode).toBe(0);
  }, 40_000);
});

describe("engineTierFor", () => {
  it("resolves an unknown tier DOWN, never up", () => {
    // An unrecognised stored value must not become `system`. The engine's own resolver
    // defaults an unset variable to its widest tier, so a mapping that guessed upward
    // would hand maximum authority to precisely the input nobody validated.
    expect(engineTierFor("wat")).toBe("supervisor");
    expect(engineTierFor("")).toBe("supervisor");
  });

  it("only ever yields a tier the engine recognises", () => {
    // Stronger than "not blank", which `undefined` and whitespace also satisfy. The
    // engine's descriptor parser rejects an empty tier before the binding check runs,
    // and resolves an unrecognised one to its own default — so anything outside this set
    // is either a refused handshake or a silent re-tiering.
    const ENGINE_TIERS = ["supervisor", "operator", "system"];
    for (const input of ["workbench", "action", "system", "wat", "", "external"]) {
      expect(ENGINE_TIERS).toContain(engineTierFor(input));
    }
  });
});
