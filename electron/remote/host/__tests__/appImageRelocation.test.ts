import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: () => "/nonexistent" },
}));

import { makeTempDir, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import {
  reconcileHostAppImage,
  relocateHostAppImageSync,
  repointUnitProgram,
  unitProgram,
} from "../appImageRelocation.js";
import { systemdUnitFor, type HostLaunchTarget } from "../startAtLogin.js";

const MARKER = '{"daintreeBuildInfo":1,"version":"1.3.0","commit":"abc123"}';
const OLD_MARKER = '{"daintreeBuildInfo":1,"version":"1.2.0","commit":"def456"}';

let root: string;
let unitFile: string;

beforeEach(async () => {
  root = await makeTempDir();
  unitFile = path.join(root, "daintree-host.service");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDir(root);
});

function imageAt(name: string, contents = "image"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, contents);
  return file;
}

function target(executable: string, appImageExtractAndRun = false): HostLaunchTarget {
  return { executable, appPath: null, appImageExtractAndRun };
}

describe("unitProgram", () => {
  it.each([
    "/home/g/Applications/Daintree-1.2.0.AppImage",
    '/home/g/My Apps/100% "real" $HOME\\Daintree.AppImage',
  ])("reads back the program the host wrote: %s", (executable) => {
    expect(unitProgram(systemdUnitFor(target(executable)))).toBe(executable);
  });

  it("finds nothing in a unit without a quoted ExecStart", () => {
    expect(unitProgram("[Service]\nExecStart=/usr/bin/true\n")).toBeNull();
  });
});

describe("repointUnitProgram", () => {
  it("yields exactly the unit the host would write for the new image, keeping its settings", () => {
    const from = "/home/g/Applications/Daintree-1.2.0.AppImage";
    const to = "/home/g/Applications/Daintree-1.3.0.AppImage";
    // The extract-and-run environment and stop script are what a FUSE-less host
    // depends on; a repoint must not drop them.
    const moved = repointUnitProgram(systemdUnitFor(target(from, true)), from, to);

    expect(moved).toBe(systemdUnitFor(target(to, true)));
  });

  it("leaves a unit that runs another program", () => {
    const unit = systemdUnitFor(target("/home/g/Applications/Daintree.AppImage.bak"));

    expect(repointUnitProgram(unit, "/home/g/Applications/Daintree.AppImage", "/x")).toBeNull();
  });
});

describe("relocateHostAppImageSync (the updater's rename)", () => {
  it("points the unit at the renamed image and reloads systemd", () => {
    const previous = path.join(root, "Daintree-1.2.0.AppImage");
    const next = imageAt("Daintree-1.3.0.AppImage");
    fs.writeFileSync(unitFile, systemdUnitFor(target(previous)));
    const reload = vi.fn();

    relocateHostAppImageSync({ previous, next }, { unitFile }, reload);

    expect(fs.readFileSync(unitFile, "utf8")).toBe(systemdUnitFor(target(next)));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves a unit for another image alone", () => {
    const other = imageAt("Daintree-nightly.AppImage");
    const unit = systemdUnitFor(target(other));
    fs.writeFileSync(unitFile, unit);
    const reload = vi.fn();

    relocateHostAppImageSync(
      {
        previous: path.join(root, "Daintree-1.2.0.AppImage"),
        next: imageAt("Daintree-1.3.0.AppImage"),
      },
      { unitFile },
      reload
    );

    expect(fs.readFileSync(unitFile, "utf8")).toBe(unit);
    expect(reload).not.toHaveBeenCalled();
  });

  it("moves the build marker with the image, emptied so it never describes the old build", () => {
    const previous = path.join(root, "Daintree-1.2.0.AppImage");
    const next = imageAt("Daintree-1.3.0.AppImage");
    fs.writeFileSync(`${previous}.build-info.json`, OLD_MARKER);

    relocateHostAppImageSync({ previous, next }, { unitFile }, vi.fn());

    expect(fs.existsSync(`${previous}.build-info.json`)).toBe(false);
    expect(fs.readFileSync(`${next}.build-info.json`, "utf8")).toBe("");
  });

  it("touches no file it can't tell is a build marker, and follows no link", () => {
    const previous = path.join(root, "Daintree-1.2.0.AppImage");
    const next = imageAt("Daintree-1.3.0.AppImage");
    fs.writeFileSync(`${previous}.build-info.json`, "someone else's notes");
    const shared = path.join(root, "shared.json");
    fs.writeFileSync(shared, "keep me");

    relocateHostAppImageSync({ previous, next }, { unitFile }, vi.fn());
    expect(fs.readFileSync(`${previous}.build-info.json`, "utf8")).toBe("someone else's notes");
    expect(fs.existsSync(`${next}.build-info.json`)).toBe(false);

    fs.writeFileSync(`${previous}.build-info.json`, OLD_MARKER);
    fs.symlinkSync(shared, `${next}.build-info.json`);
    relocateHostAppImageSync({ previous, next }, { unitFile }, vi.fn());
    expect(fs.readFileSync(shared, "utf8")).toBe("keep me");
    expect(fs.lstatSync(`${next}.build-info.json`).isSymbolicLink()).toBe(true);
  });

  it("creates no marker for an image installed without one", () => {
    const previous = path.join(root, "Daintree-1.2.0.AppImage");
    const next = imageAt("Daintree-1.3.0.AppImage");

    relocateHostAppImageSync({ previous, next }, { unitFile }, vi.fn());

    expect(fs.existsSync(`${next}.build-info.json`)).toBe(false);
    expect(fs.existsSync(unitFile)).toBe(false);
  });
});

describe("reconcileHostAppImage (startup)", () => {
  const startedLater = () => Date.now() + 60_000;

  it("points a unit whose AppImage is gone at the image this process runs from", async () => {
    const image = imageAt("Daintree-1.3.0.AppImage");
    fs.writeFileSync(unitFile, systemdUnitFor(target(path.join(root, "Daintree-1.2.0.AppImage"))));
    const reloadUnits = vi.fn(async () => {});

    await reconcileHostAppImage({
      image,
      files: { unitFile },
      ownMarker: null,
      startedAtMs: startedLater(),
      reloadUnits,
    });

    expect(fs.readFileSync(unitFile, "utf8")).toBe(systemdUnitFor(target(image)));
    expect(reloadUnits).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another AppImage that still exists", () => imageAt("Daintree-nightly.AppImage")],
    [
      "a versioned AppImage missing from another folder (an unmounted drive)",
      () => path.join(root, "usb", "Daintree-1.2.0.AppImage"),
    ],
    [
      "an AppImage without a version, which the updater never renames",
      () => path.join(root, "Daintree.AppImage"),
    ],
    ["the deb's binary, even once removed", () => "/opt/Daintree-test-missing/daintree"],
  ])("leaves a unit that runs %s", async (_label, program) => {
    const image = imageAt("Daintree-1.3.0.AppImage");
    const unit = systemdUnitFor(target(program()));
    fs.writeFileSync(unitFile, unit);
    const reloadUnits = vi.fn(async () => {});

    await reconcileHostAppImage({
      image,
      files: { unitFile },
      ownMarker: null,
      startedAtMs: startedLater(),
      reloadUnits,
    });

    expect(fs.readFileSync(unitFile, "utf8")).toBe(unit);
    expect(reloadUnits).not.toHaveBeenCalled();
  });

  it("brings a marker the update left behind up to this build", async () => {
    const image = imageAt("Daintree.AppImage");
    fs.writeFileSync(`${image}.build-info.json`, OLD_MARKER);

    await reconcileHostAppImage({
      image,
      files: { unitFile },
      ownMarker: MARKER,
      startedAtMs: startedLater(),
      reloadUnits: async () => {},
    });

    expect(fs.readFileSync(`${image}.build-info.json`, "utf8")).toBe(MARKER);
  });

  it("never vouches for an image replaced after this process started", async () => {
    const image = imageAt("Daintree.AppImage");
    fs.writeFileSync(`${image}.build-info.json`, OLD_MARKER);
    const startedAtMs = Date.now() - 1_000;
    // An older download moved into place keeps its old mtime; the move itself
    // is what dates it (ctime).
    const old = new Date(startedAtMs - 3_600_000);
    fs.utimesSync(image, old, old);

    await reconcileHostAppImage({
      image,
      files: { unitFile },
      ownMarker: MARKER,
      startedAtMs,
      reloadUnits: async () => {},
    });

    expect(fs.statSync(image).mtimeMs).toBeLessThan(startedAtMs);
    expect(fs.readFileSync(`${image}.build-info.json`, "utf8")).toBe(OLD_MARKER);
  });

  it("leaves a file beside the image that isn't a build marker", async () => {
    const image = imageAt("Daintree.AppImage");
    fs.writeFileSync(`${image}.build-info.json`, "someone else's notes");

    await reconcileHostAppImage({
      image,
      files: { unitFile },
      ownMarker: MARKER,
      startedAtMs: startedLater(),
      reloadUnits: async () => {},
    });

    expect(fs.readFileSync(`${image}.build-info.json`, "utf8")).toBe("someone else's notes");
  });

  it("writes no marker where none was installed, nor one that isn't a build marker", async () => {
    const bare = imageAt("Daintree.AppImage");
    const marked = imageAt("Daintree-marked.AppImage");
    fs.writeFileSync(`${marked}.build-info.json`, OLD_MARKER);

    await reconcileHostAppImage({
      image: bare,
      files: { unitFile },
      ownMarker: MARKER,
      startedAtMs: startedLater(),
      reloadUnits: async () => {},
    });
    await reconcileHostAppImage({
      image: marked,
      files: { unitFile },
      ownMarker: '{"daintreeBuildInfo":1,"version":"1.3.0","commit":"unknown"}',
      startedAtMs: startedLater(),
      reloadUnits: async () => {},
    });

    expect(fs.existsSync(`${bare}.build-info.json`)).toBe(false);
    expect(fs.readFileSync(`${marked}.build-info.json`, "utf8")).toBe(OLD_MARKER);
  });
});
