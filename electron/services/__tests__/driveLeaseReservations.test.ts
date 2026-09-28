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

    store.save({ p1: { clientId: "c1", clientName: "laptop" } });

    expect(store.load()).toEqual({ p1: { clientId: "c1", clientName: "laptop" } });
    const file = path.join(dir, "drive-lease-reservations.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      p1: { clientId: "c1", clientName: "laptop" },
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
          noName: { clientId: "c" },
          empty: { clientId: "", clientName: "n" },
          wrong: 5,
          long: { clientId: "x".repeat(600), clientName: "n" },
        })
      )
    ).toEqual({ ok: { clientId: "c", clientName: "n" } });
    expect(parseReservations("[]")).toEqual({});
    expect(parseReservations("null")).toEqual({});
  });
});
