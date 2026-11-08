import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { isSha512Base64, lookupArtifactChecksum } from "../../client/clientBuild.js";
import { artifactNameFor, feedUrlFor } from "../../client/installPlan.js";
import { feedEntryFor, updateManifestFor, wrongSha512Base64 } from "./releaseFeed.js";

const SHA512 = crypto.createHash("sha512").update("a build").digest("base64");

/** A feed that serves what is published on it, and 404s the rest. */
function feedServing(files: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = files[url.pathname.slice(1)];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  }) as typeof fetch;
}

describe("the host install target's release feed", () => {
  it.each([
    { version: "1.4.0", arch: "x64" as const, manifest: "releases/latest-linux.yml" },
    { version: "1.4.0", arch: "arm64" as const, manifest: "releases/latest-linux-arm64.yml" },
    {
      version: "1.4.0-nightly.20261107083748.2d1292d",
      arch: "arm64" as const,
      manifest: "nightly/latest-linux-arm64.yml",
    },
  ])(
    "serves $version on $arch where the installer asks for it",
    async ({ version, arch, manifest }) => {
      const artifactName = artifactNameFor(arch, "appimage", version);
      const entry = feedEntryFor(version, arch);

      // The URL the plan will hand the host, and the manifest the checksum is read from.
      expect(entry.url).toBe(`${feedUrlFor(version)}${artifactName}`);
      expect(entry.manifestPath).toBe(manifest);
      expect(new URL(entry.url).pathname.slice(1)).toBe(entry.artifactPath);

      const checksum = await lookupArtifactChecksum({
        url: entry.url,
        fetchImpl: feedServing({
          [entry.manifestPath]: updateManifestFor({
            version,
            artifactName: entry.artifactName,
            sha512: SHA512,
            size: 1234,
          }),
        }),
      });
      expect(checksum).toEqual({ sha512: SHA512, size: 1234 });
    }
  );

  it("has a wrong checksum the manifest parser takes, so the host's own check is what refuses it", async () => {
    const wrong = wrongSha512Base64(SHA512);
    expect(wrong).not.toBe(SHA512);
    expect(isSha512Base64(wrong)).toBe(true);

    const entry = feedEntryFor("1.4.0", "x64");
    const checksum = await lookupArtifactChecksum({
      url: entry.url,
      fetchImpl: feedServing({
        [entry.manifestPath]: updateManifestFor({
          version: "1.4.0",
          artifactName: entry.artifactName,
          sha512: wrong,
          size: 1234,
        }),
      }),
    });
    expect(checksum?.sha512).toBe(wrong);
  });
});
