import { describe, expect, it } from "vitest";
import type {
  DecisionsInvolvementPreference,
  DecisionsInvolvementRead,
} from "@shared/types/decisionsInvolvement";
import {
  OVERRIDE_MAX_MS,
  draftFrom,
  draftIssue,
  draftPayload,
  inForce,
  localDateTime,
  modeDetail,
  msUntilChange,
  parseLocalDateTime,
  readOnlyText,
  sameDraft,
  saveNotice,
  setOnText,
  thenText,
  unavailableLabel,
  unavailableText,
  type AvailablePreference,
} from "../decisionsInvolvementModel";

const NOW = Date.parse("2026-11-18T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function available(over: Partial<AvailablePreference> = {}): AvailablePreference {
  return {
    status: "available",
    normalMode: "recommend",
    consultCount: 2,
    override: null,
    mode: "recommend",
    overrideActive: false,
    revision: 3,
    setOn: "phone",
    setAt: "2026-11-18T09:00:00.000Z",
    lastSyncedAt: "2026-11-18T09:59:00.000Z",
    stale: false,
    ...over,
  };
}

function read(
  preference: DecisionsInvolvementPreference,
  over: Partial<Extract<DecisionsInvolvementRead, { result: "read" }>> = {}
): Extract<DecisionsInvolvementRead, { result: "read" }> {
  return { result: "read", preference, role: "owner", settable: true, ...over };
}

describe("decisionsInvolvementModel", () => {
  describe("inForce", () => {
    it("is the temporary mode until it ends, then the normal one, without a new read", () => {
      const until = new Date(NOW + HOUR).toISOString();
      const preference = available({ override: { mode: "involve-early", until } });

      expect(inForce(preference, NOW)).toEqual({ mode: "involve-early", until });
      expect(inForce(preference, NOW + HOUR - 1)).toEqual({ mode: "involve-early", until });
      expect(inForce(preference, NOW + HOUR)).toEqual({ mode: "recommend", until: null });
      expect(msUntilChange(preference, NOW)).toBe(HOUR);
      expect(msUntilChange(preference, NOW + HOUR)).toBeNull();
    });

    it("is the normal mode with no temporary one, and changes on no timer", () => {
      expect(inForce(available({ normalMode: "involve-early" }), NOW)).toEqual({
        mode: "involve-early",
        until: null,
      });
      expect(msUntilChange(available(), NOW)).toBeNull();
      expect(
        msUntilChange(
          {
            status: "unavailable",
            reason: "not-set",
            revision: 0,
            lastSyncedAt: null,
            stale: false,
          },
          NOW
        )
      ).toBeNull();
    });
  });

  it("names where a preference was set, the owner computer being this one unless it is a Remote Host", () => {
    expect(setOnText("computer", "owner")).toContain("this computer");
    expect(setOnText("computer", "host")).toContain("the owner computer");
    expect(setOnText("phone", "host")).toContain("a phone or tablet");
  });

  it("says what follows a temporary mode, with the count a recommendation consults", () => {
    expect(thenText(available({ consultCount: 4 }))).toContain("consulting 4 other agents");
    expect(
      thenText(
        available({
          consultCount: 7,
          override: { mode: "involve-early", until: new Date(NOW + HOUR).toISOString() },
          mode: "involve-early",
          overrideActive: true,
        })
      )
    ).toBe("then bring a recommendation, consulting 7 other agents");
    expect(thenText(available({ normalMode: "involve-early", consultCount: 4 }))).toBe(
      "then ask while exploring"
    );
  });

  it("says how many other agents a recommendation consults", () => {
    expect(modeDetail("recommend", 1)).toContain("1 other agent first");
    expect(modeDetail("recommend", 3)).toContain("3 other agents first");
    expect(modeDetail("involve-early", 3)).not.toContain("3");
  });

  it("names why none is in force in a few words for one line, and in a sentence otherwise", () => {
    const reasons = [
      "not-set",
      "not-synced",
      "unsupported",
      "signer-revoked",
      "device-revoked",
    ] as const;
    // Each reason keeps its own words when shortened.
    expect(new Set(reasons.map(unavailableLabel)).size).toBe(reasons.length);
    for (const reason of [
      "not-set",
      "not-synced",
      "unsupported",
      "signer-revoked",
      "device-revoked",
    ] as const) {
      expect(unavailableLabel(reason)).not.toMatch(/\.$/);
      expect(unavailableText(reason).length).toBeGreaterThan(unavailableLabel(reason).length);
    }
  });

  describe("drafts", () => {
    it("counts two drafts as the same only when they would save the same preference", () => {
      const until = "2026-11-18T12:34:56.789Z";
      const temporary = draftFrom(available({ override: { mode: "involve-early", until } }), NOW);
      expect(sameDraft(temporary, { ...temporary })).toBe(true);
      expect(sameDraft(temporary, { ...temporary, consultCount: 3 })).toBe(false);
      expect(sameDraft(temporary, { ...temporary, temporaryMode: "recommend" })).toBe(false);
      // Typing the same minute back drops the end's seconds: a different end.
      expect(
        sameDraft(temporary, {
          ...temporary,
          until: localDateTime(Date.parse(until)),
          keptUntil: null,
        })
      ).toBe(false);

      const permanent = draftFrom(available(), NOW);
      expect(sameDraft(permanent, { ...permanent, normalMode: "involve-early" })).toBe(false);
      // A temporary mode's fields mean nothing while it is off.
      expect(sameDraft(permanent, { ...permanent, temporaryMode: "recommend", until: "" })).toBe(
        true
      );
      expect(sameDraft(permanent, { ...permanent, temporary: true })).toBe(false);
      expect(sameDraft(permanent, { ...permanent, consultCount: Number.NaN })).toBe(false);
    });

    it("starts from the preference reviewed, keeping an active temporary mode and its exact end", () => {
      const until = "2026-11-18T12:34:56.789Z";
      // The same mode as the normal one, which no default would pick.
      const draft = draftFrom(available({ override: { mode: "recommend", until } }), NOW);

      expect(draft).toMatchObject({
        normalMode: "recommend",
        consultCount: 2,
        temporary: true,
        temporaryMode: "recommend",
        keptUntil: until,
      });
      expect(draftIssue(draft, NOW)).toBeNull();
      expect(draftPayload(draft, 3)).toEqual({
        expectedRevision: 3,
        normalMode: "recommend",
        consultCount: 2,
        override: { mode: "recommend", until },
      });
    });

    it("leaves an ended temporary mode out, since the relay refuses saving it again", () => {
      const until = new Date(NOW - HOUR).toISOString();
      const draft = draftFrom(available({ override: { mode: "involve-early", until } }), NOW);

      expect(draft.temporary).toBe(false);
      expect(draft.keptUntil).toBeNull();
      expect(draftPayload(draft, 3).override).toBeNull();
    });

    it("offers the other mode for a while, ending in the future, when there is no temporary one", () => {
      const draft = draftFrom(available({ normalMode: "involve-early" }), NOW);

      expect(draft.temporaryMode).toBe("recommend");
      const until = parseLocalDateTime(draft.until);
      expect(until).toBeGreaterThan(NOW);
      expect(draftIssue({ ...draft, temporary: true }, NOW)).toBeNull();
    });

    it("starts a first preference from valid choices, replacing the revision this computer verified", () => {
      const draft = draftFrom(
        { status: "unavailable", reason: "not-set", revision: 0, lastSyncedAt: null, stale: false },
        NOW
      );

      expect(draftIssue(draft, NOW)).toBeNull();
      expect(draftPayload(draft, 0)).toMatchObject({ expectedRevision: 0, override: null });
    });

    it("sends a time typed into the field as UTC with milliseconds", () => {
      const local = localDateTime(NOW + 2 * HOUR);
      const draft = { ...draftFrom(available(), NOW), temporary: true, until: local };

      const override = draftPayload(draft, 3).override;
      expect(override?.until).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
      expect(Date.parse(override!.until)).toBe(parseLocalDateTime(local));
      expect(localDateTime(Date.parse(override!.until))).toBe(local);
    });

    it.each([0, 9, Number.NaN, 1.5, -1])(
      "refuses %s other agents, as the relay would, on the count's field",
      (consultCount) => {
        expect(draftIssue({ ...draftFrom(available(), NOW), consultCount }, NOW)).toEqual({
          field: "count",
          text: "Enter a whole number from 1 to 8.",
        });
      }
    );

    it.each([1, 8])("takes %s other agents", (consultCount) => {
      expect(draftIssue({ ...draftFrom(available(), NOW), consultCount }, NOW)).toBeNull();
    });

    it("takes a temporary mode ending after now and at most 30 days on, to the millisecond", () => {
      const draft = { ...draftFrom(available(), NOW), temporary: true };
      const at = (ms: number) => ({ ...draft, keptUntil: new Date(ms).toISOString() });
      const THIRTY_DAYS = 2_592_000_000;

      expect(draftIssue(at(NOW + 1), NOW)).toBeNull();
      expect(draftIssue(at(NOW + THIRTY_DAYS), NOW)).toBeNull();
      expect(draftIssue(at(NOW), NOW)).toEqual({
        field: "until",
        text: "It has to end in the future.",
      });
      expect(draftIssue(at(NOW - 1), NOW)?.text).toContain("future");
      expect(draftIssue(at(NOW + THIRTY_DAYS + 1), NOW)).toEqual({
        field: "until",
        text: "It can last at most 30 days.",
      });
    });

    it("refuses a typed end that has passed, is too far off, or is missing", () => {
      const draft = { ...draftFrom(available(), NOW), temporary: true, keptUntil: null };

      expect(draftIssue({ ...draft, until: localDateTime(NOW - 60_000) }, NOW)?.text).toContain(
        "future"
      );
      expect(
        draftIssue({ ...draft, until: localDateTime(NOW + OVERRIDE_MAX_MS + HOUR) }, NOW)?.text
      ).toContain("30 days");
      expect(draftIssue({ ...draft, until: "" }, NOW)).toEqual({
        field: "until",
        text: "Choose when it ends.",
      });
    });

    it("refuses a local time the clocks skip, which would otherwise be saved an hour later", () => {
      const zone = process.env.TZ;
      process.env.TZ = "America/New_York";
      try {
        // 2026-03-08 02:30 doesn't exist in New York: the clocks go from 02:00 to 03:00.
        expect(parseLocalDateTime("2026-03-08T02:30")).toBeNaN();
        expect(parseLocalDateTime("2026-03-08T03:30")).toBe(Date.parse("2026-03-08T07:30:00.000Z"));
        const draft = {
          ...draftFrom(available(), Date.parse("2026-03-07T12:00:00.000Z")),
          temporary: true,
          keptUntil: null,
          until: "2026-03-08T02:30",
        };
        expect(draftIssue(draft, Date.parse("2026-03-07T12:00:00.000Z"))?.text).toContain(
          "The clocks skip that time"
        );
      } finally {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
      }
    });

    it("ignores the temporary fields while there's no temporary mode", () => {
      const draft = { ...draftFrom(available(), NOW), temporary: false, until: "" };
      expect(draftIssue(draft, NOW)).toBeNull();
    });

    it("reads only a whole local date and time", () => {
      expect(parseLocalDateTime("2026-11-18T09:30")).toBe(new Date(2026, 10, 18, 9, 30).getTime());
      expect(parseLocalDateTime("2026-11-18")).toBeNaN();
      expect(parseLocalDateTime("2026-11-18T09:30:00Z")).toBeNaN();
    });
  });

  describe("readOnlyText", () => {
    it("lets the owner computer change it while connected", () => {
      expect(readOnlyText(read(available()), false)).toBeNull();
    });

    it("says why it can't be changed here", () => {
      expect(readOnlyText(read(available(), { role: "host", settable: false }), false)).toContain(
        "Remote Host"
      );
      expect(
        readOnlyText(
          read({
            status: "unavailable",
            reason: "unsupported",
            revision: 0,
            lastSyncedAt: null,
            stale: false,
          }),
          false
        )
      ).toContain("Update the relay");
      expect(readOnlyText(read(available()), true)).toContain("0.8.0");
      expect(readOnlyText(read(available(), { settable: false }), false)).toContain("reconnects");
      expect(
        readOnlyText(
          read({
            status: "unavailable",
            reason: "device-revoked",
            revision: 2,
            lastSyncedAt: null,
            stale: true,
          }),
          false
        )
      ).toContain("phone");
    });
  });

  describe("saveNotice", () => {
    it("says nothing of a change the relay took", () => {
      expect(saveNotice({ result: "saved", revision: 4 })).toBeNull();
    });

    it.each([5, 1, null])(
      "tells the person the relay holds a different version (revision %s), and that their change wasn't saved",
      (latestRevision) => {
        const notice = saveNotice({ result: "conflict", latestRevision });
        expect(notice).toMatchObject({ severity: "warning", relayRefusal: false });
        expect(notice?.text).toContain("holds a different version of the preference");
        expect(notice?.text).toContain("wasn't saved");
      }
    );

    it("leaves it read only once the relay turns away a change from this computer", () => {
      expect(saveNotice({ result: "unsupported" })?.relayRefusal).toBe(true);
      expect(
        saveNotice({ result: "refused", reason: "relay", code: "forbidden" })?.relayRefusal
      ).toBe(true);
      expect(
        saveNotice({ result: "refused", reason: "relay", code: "rate_limited" })
      ).toMatchObject({ relayRefusal: false });
    });

    it("never claims a change whose fate is unknown was saved or lost", () => {
      const notice = saveNotice({ result: "unconfirmed" });
      expect(notice?.text).toContain("couldn't confirm whether your change was saved");
      expect(notice?.text).not.toContain("wasn't");
      expect(notice?.text).not.toContain("relay couldn't be reached");
    });

    it("says the relay removed this computer, and that the change wasn't sent", () => {
      const notice = saveNotice({ result: "refused", reason: "revoked" });
      expect(notice).toMatchObject({ severity: "error", relayRefusal: false });
      expect(notice?.text).toContain("removed this computer");
      expect(notice?.text).toContain("wasn't sent");
    });

    it("carries the reason a change was invalid", () => {
      expect(
        saveNotice({ result: "refused", reason: "invalid", detail: "override.until: too far" })
          ?.text
      ).toContain("override.until: too far");
    });
  });
});
