import { describe, expect, it } from "vitest";
import type { HostProbeResult } from "../../../../shared/types/ipc/remoteHosts.js";
import {
  NIGHTLY_FEED_URL,
  STABLE_FEED_URL,
  artifactNameFor,
  debInstallCommand,
  feedUrlFor,
  planInstall,
  type ClientBuild,
} from "../installPlan.js";

const macClient: ClientBuild = {
  platform: "darwin",
  arch: "arm64",
  version: "1.4.0",
  commit: "abcdef0123",
  channel: "stable",
  bundle: { kind: "app-bundle", path: "/Applications/Daintree.app" },
};

function probe(overrides: Partial<HostProbeResult> = {}): HostProbeResult {
  return {
    sshTarget: "studio",
    reachable: true,
    sshError: null,
    platform: "darwin",
    arch: "arm64",
    install: null,
    hostModeListening: false,
    suggestedCommands: [],
    appRunning: false,
    appImages: [],
    canDownload: true,
    matchesClient: false,
    advice: {
      sleepObserved: null,
      sleepDisabled: null,
      keyring: null,
      linger: null,
      hostModeUnit: null,
      startAtLoginInstalled: null,
      fuse: null,
    },
    hostModeState: null,
    ...overrides,
  };
}

describe("planInstall", () => {
  it("pushes this machine's own bundle to a host of the same platform and arch", () => {
    const plan = planInstall({ client: macClient, probe: probe() });
    expect(plan).toMatchObject({
      kind: "install",
      delivery: "push-bundle",
      packaging: "app-bundle",
      version: "1.4.0",
      commit: "abcdef0123",
      artifactUrl: null,
      userCommandNeeded: false,
    });
  });

  it("has a different-arch Mac fetch its own artifact for the exact version", () => {
    const plan = planInstall({ client: macClient, probe: probe({ arch: "x64" }) });
    expect(plan.delivery).toBe("host-fetch");
    expect(plan.artifactName).toBe("Daintree-1.4.0-x64-mac.zip");
    expect(plan.artifactUrl).toBe(`${STABLE_FEED_URL}Daintree-1.4.0-x64-mac.zip`);
  });

  it("downloads here and copies over when the host can't download", () => {
    const plan = planInstall({
      client: macClient,
      probe: probe({ platform: "linux", arch: "x64", canDownload: false }),
    });
    expect(plan.delivery).toBe("client-download-push");
    expect(plan.artifactName).toBe("daintree_1.4.0_amd64.deb");
  });

  it("prefers the deb on Linux, which ends in a command the user runs", () => {
    const plan = planInstall({
      client: macClient,
      probe: probe({ platform: "linux", arch: "arm64" }),
    });
    expect(plan.packaging).toBe("deb");
    expect(plan.userCommandNeeded).toBe(true);
    expect(plan.restartsHost).toBe(false);
    expect(plan.artifactName).toBe("daintree_1.4.0_arm64.deb");
  });

  it("keeps an AppImage host on the AppImage and honours an explicit choice", () => {
    const appImageHost = probe({
      platform: "linux",
      arch: "x64",
      install: {
        path: "/home/g/Applications/Daintree.AppImage",
        version: "1.3.0",
        commit: null,
        packaging: "appimage",
      },
      appRunning: true,
    });
    const kept = planInstall({ client: macClient, probe: appImageHost });
    expect(kept.packaging).toBe("appimage");
    expect(kept.artifactName).toBe("Daintree-1.4.0-x86_64.AppImage");
    expect(kept.userCommandNeeded).toBe(false);
    expect(kept.restartsHost).toBe(true);
    const chosen = planInstall({ client: macClient, probe: appImageHost, linuxPackage: "deb" });
    expect(chosen.packaging).toBe("deb");
  });

  it("pushes a Linux client's own AppImage to a same-arch Linux host that wants one", () => {
    const linuxClient: ClientBuild = {
      ...macClient,
      platform: "linux",
      arch: "x64",
      bundle: { kind: "appimage", path: "/home/g/Daintree.AppImage" },
    };
    const host = probe({ platform: "linux", arch: "x64" });
    expect(
      planInstall({ client: linuxClient, probe: host, linuxPackage: "appimage" }).delivery
    ).toBe("push-bundle");
    // The deb isn't something the client has, so it comes from the feed.
    expect(planInstall({ client: linuxClient, probe: host }).delivery).toBe("host-fetch");
  });

  it("fetches from the feed when this machine has no bundle to copy (a dev or deb install)", () => {
    const plan = planInstall({
      client: { ...macClient, bundle: { kind: "none" } },
      probe: probe(),
    });
    expect(plan.delivery).toBe("host-fetch");
  });

  it("follows this client's channel: a nightly build comes from the nightly feed", () => {
    const nightly: ClientBuild = {
      ...macClient,
      version: "1.5.0-nightly.20260925",
      channel: "nightly",
    };
    const plan = planInstall({ client: nightly, probe: probe({ arch: "x64" }) });
    expect(plan.channel).toBe("nightly");
    expect(plan.artifactUrl).toBe(`${NIGHTLY_FEED_URL}Daintree-1.5.0-nightly.20260925-x64-mac.zip`);
    expect(feedUrlFor("1.4.0")).toBe(STABLE_FEED_URL);
  });

  it("says up to date, or why nothing can be done", () => {
    expect(planInstall({ client: macClient, probe: probe({ matchesClient: true }) }).kind).toBe(
      "up-to-date"
    );
    const unreachable = planInstall({ client: macClient, probe: probe({ reachable: false }) });
    expect(unreachable.kind).toBe("unsupported");
    expect(unreachable.reason).toMatch(/SSH/);
    expect(planInstall({ client: macClient, probe: probe({ arch: null }) }).kind).toBe(
      "unsupported"
    );
  });

  it("restarts the host only when Daintree is running there", () => {
    expect(planInstall({ client: macClient, probe: probe() }).restartsHost).toBe(false);
    expect(
      planInstall({ client: macClient, probe: probe({ appRunning: true }) }).restartsHost
    ).toBe(true);
  });
});

describe("planInstall with conflicting AppImages", () => {
  it("won't plan an AppImage update while it can't tell which AppImage is used", () => {
    const linux = probe({
      platform: "linux",
      arch: "x64",
      install: {
        path: "/home/g/Applications/a.AppImage",
        version: "1.3.0",
        commit: null,
        packaging: "appimage",
      },
    });
    const plan = planInstall({
      client: macClient,
      probe: linux,
      appImageConflict: "There are 2 Daintree AppImages in ~/Applications",
    });
    expect(plan).toMatchObject({
      kind: "unsupported",
      reason: expect.stringMatching(/2 Daintree/),
    });
    // The deb doesn't touch the AppImages, so it can still be planned.
    expect(
      planInstall({ client: macClient, probe: linux, linuxPackage: "deb", appImageConflict: "x" })
        .kind
    ).toBe("install");
  });
});

describe("debInstallCommand", () => {
  it("quotes a staged path the user's shell would otherwise split", () => {
    expect(debInstallCommand("/tmp/daintree-stage.abc/daintree_1.4.0_amd64.deb")).toBe(
      "sudo apt install /tmp/daintree-stage.abc/daintree_1.4.0_amd64.deb"
    );
    expect(debInstallCommand("/tmp/my stage/it's.deb")).toBe(
      `sudo apt install '/tmp/my stage/it'"'"'s.deb'`
    );
  });
});

describe("artifactNameFor", () => {
  it("names artifacts as the release build does", () => {
    expect(artifactNameFor("arm64", "app-bundle", "2.0.0")).toBe("Daintree-2.0.0-arm64-mac.zip");
    expect(artifactNameFor("x64", "deb", "2.0.0")).toBe("daintree_2.0.0_amd64.deb");
    expect(artifactNameFor("arm64", "appimage", "2.0.0")).toBe("Daintree-2.0.0-arm64.AppImage");
  });
});
