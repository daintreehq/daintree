import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileReservationStore, parseReservations } from "../driveLeaseReservations.js";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("drive lease reservations on disk", () => {
  it("round-trips what it saves, owner-only", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dlr-"));
    const store = createFileReservationStore(dir);
    expect(store.load()).toEqual({});

    store.save({
      p1: { clientId: "c1", clientName: "laptop" },
      p2: { clientId: "c1", clientName: "laptop", tenureId: "t-1" },
    });

    expect(store.load()).toEqual({
      p1: { clientId: "c1", clientName: "laptop" },
      p2: { clientId: "c1", clientName: "laptop", tenureId: "t-1" },
    });
    const file = path.join(dir, "drive-lease-reservations.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      p1: { clientId: "c1", clientName: "laptop" },
      p2: { clientId: "c1", clientName: "laptop", tenureId: "t-1" },
    });
  });

  it("keeps a project nobody held only with the tenure it waits on (#15918)", () => {
    expect(
      parseReservations(
        JSON.stringify({
          kept: { clientId: "c1", clientName: "laptop", tenureId: "t-1", vacant: true },
          noTenure: { clientId: "c1", clientName: "laptop", vacant: true },
          notVacant: { clientId: "c1", clientName: "laptop", tenureId: "t-2", vacant: "yes" },
        })
      )
    ).toEqual({
      kept: { clientId: "c1", clientName: "laptop", tenureId: "t-1", vacant: true },
      notVacant: { clientId: "c1", clientName: "laptop", tenureId: "t-2" },
    });
  });

  it("ignores a damaged file rather than failing to start", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dlr-"));
    writeFileSync(path.join(dir, "drive-lease-reservations.json"), "{not json");
    expect(createFileReservationStore(dir).load()).toEqual({});
  });

  it("keeps only well-formed entries", () => {
    expect(
      parseReservations(
        JSON.stringify({
          ok: { clientId: "c", clientName: "n" },
          tenure: { clientId: "c", clientName: "n", tenureId: "t" },
          badTenure: { clientId: "c", clientName: "n", tenureId: 7 },
          emptyTenure: { clientId: "c", clientName: "n", tenureId: "" },
          longestTenure: { clientId: "c", clientName: "n", tenureId: "t".repeat(256) },
          tooLongTenure: { clientId: "c", clientName: "n", tenureId: "t".repeat(257) },
          noName: { clientId: "c" },
          empty: { clientId: "", clientName: "n" },
          wrong: 5,
          long: { clientId: "x".repeat(600), clientName: "n" },
        })
      )
    ).toEqual({
      ok: { clientId: "c", clientName: "n" },
      tenure: { clientId: "c", clientName: "n", tenureId: "t" },
      // A tenure it can't read, or the link couldn't carry, starts afresh; the
      // reservation itself still holds.
      badTenure: { clientId: "c", clientName: "n" },
      emptyTenure: { clientId: "c", clientName: "n" },
      longestTenure: { clientId: "c", clientName: "n", tenureId: "t".repeat(256) },
      tooLongTenure: { clientId: "c", clientName: "n" },
    });
    expect(parseReservations("[]")).toEqual({});
    expect(parseReservations("null")).toEqual({});
  });

  it("keeps a holder's install, and a reservation whose install is missing or damaged (#13909)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dlr-"));
    const store = createFileReservationStore(dir);
    store.save({ p1: { clientId: "c1", clientName: "laptop", deviceId: "install-1" } });
    expect(store.load()).toEqual({
      p1: { clientId: "c1", clientName: "laptop", deviceId: "install-1" },
    });

    expect(
      parseReservations(
        JSON.stringify({
          saved: { clientId: "c", clientName: "n", deviceId: "d" },
          older: { clientId: "c", clientName: "n" },
          wrongType: { clientId: "c", clientName: "n", deviceId: 7 },
          empty: { clientId: "c", clientName: "n", deviceId: "" },
          long: { clientId: "c", clientName: "n", deviceId: "x".repeat(600) },
        })
      )
    ).toEqual({
      saved: { clientId: "c", clientName: "n", deviceId: "d" },
      older: { clientId: "c", clientName: "n" },
      wrongType: { clientId: "c", clientName: "n" },
      empty: { clientId: "c", clientName: "n" },
      long: { clientId: "c", clientName: "n" },
    });
  });
});
