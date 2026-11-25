import { describe, expect, it } from "vitest";
import { isImage, publishDecision, pullToken, readManifest } from "./host-image-registry.mjs";

const repository = "daintreehq/daintree-host";
const imageId = `sha256:${"a".repeat(64)}`;
const digest = `sha256:${"b".repeat(64)}`;
const image = {
  mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  config: { digest: imageId },
  layers: [],
};

/** A registry that gives `answer` to every request, and remembers what it was asked. */
function registry(answer) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} });
    return answer;
  };
  return { fetchImpl, seen };
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("readManifest", () => {
  it.each([["MANIFEST_UNKNOWN"], ["NAME_UNKNOWN"]])(
    "reads a 404 saying %s as no such tag",
    async (code) => {
      const { fetchImpl, seen } = registry(json(404, { errors: [{ code }] }));
      await expect(
        readManifest({ repository, reference: "1.2.3", bearer: "t", fetchImpl })
      ).resolves.toEqual({ found: false });
      expect(seen[0].url).toBe(`https://ghcr.io/v2/${repository}/manifests/1.2.3`);
      // Without OCI types in Accept, GHCR answers 404 for an OCI manifest that's there.
      expect(seen[0].headers.accept).toContain("application/vnd.oci.image.index.v1+json");
    }
  );

  it.each([
    ["a 404 without the registry's error document", new Response("Not Found", { status: 404 })],
    ["a 404 for another reason", json(404, { errors: [{ code: "BLOB_UNKNOWN" }] })],
    ["a refusal", json(403, { errors: [{ code: "DENIED" }] })],
    ["an unauthorized token", json(401, { errors: [{ code: "UNAUTHORIZED" }] })],
    ["a server error", new Response("upstream", { status: 503 })],
  ])("throws on %s rather than call the tag free", async (_label, answer) => {
    const { fetchImpl } = registry(answer);
    await expect(
      readManifest({ repository, reference: "1.2.3", bearer: "t", fetchImpl })
    ).rejects.toThrow(/GHCR answered/);
  });

  it("returns the digest the registry names and the manifest", async () => {
    const { fetchImpl } = registry(json(200, image, { "docker-content-digest": digest }));
    await expect(
      readManifest({ repository, reference: "1.2.3", bearer: "t", fetchImpl })
    ).resolves.toEqual({ found: true, digest, manifest: image });
  });

  it("throws when a found manifest comes without a digest", async () => {
    const { fetchImpl } = registry(json(200, image));
    await expect(
      readManifest({ repository, reference: "1.2.3", bearer: "t", fetchImpl })
    ).rejects.toThrow(/no digest/);
  });
});

describe("publishDecision", () => {
  const params = { repository, version: "1.2.3", imageId };

  it("pushes a version the registry has no tag for", () => {
    expect(publishDecision({ found: false }, params)).toBe("push");
  });

  it("finds a rerun's own push there and doesn't push again", () => {
    expect(publishDecision({ found: true, digest, manifest: image }, params)).toBe("pushed");
  });

  it.each([
    ["another image", { ...image, config: { digest: `sha256:${"c".repeat(64)}` } }],
    ["an index", { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [image] }],
  ])("refuses a version that already holds %s", (_label, manifest) => {
    expect(() => publishDecision({ found: true, digest, manifest }, params)).toThrow(
      /already exists.*published once/
    );
  });
});

describe("isImage", () => {
  it("matches one image by its config's digest, whichever manifest format", () => {
    expect(isImage(image, imageId)).toBe(true);
    expect(
      isImage({ ...image, mediaType: "application/vnd.oci.image.manifest.v1+json" }, imageId)
    ).toBe(true);
    expect(isImage(image, `sha256:${"d".repeat(64)}`)).toBe(false);
  });
});

describe("pullToken", () => {
  it("asks for a pull token with the credentials it has, and as anyone without", async () => {
    const withCredentials = registry(json(200, { token: "issued" }));
    await expect(
      pullToken({ repository, user: "bot", token: "secret", fetchImpl: withCredentials.fetchImpl })
    ).resolves.toBe("issued");
    expect(withCredentials.seen[0].url).toBe(
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`
    );
    expect(withCredentials.seen[0].headers.authorization).toBe(
      `Basic ${Buffer.from("bot:secret").toString("base64")}`
    );

    const anonymous = registry(json(200, { token: "public" }));
    await expect(pullToken({ repository, fetchImpl: anonymous.fetchImpl })).resolves.toBe("public");
    expect(anonymous.seen[0].headers.authorization).toBeUndefined();
  });

  it("throws when the registry gives no token", async () => {
    await expect(
      pullToken({ repository, fetchImpl: registry(json(403, { errors: [] })).fetchImpl })
    ).rejects.toThrow(/no token/);
    await expect(
      pullToken({ repository, fetchImpl: registry(json(200, {})).fetchImpl })
    ).rejects.toThrow(/had no token/);
  });
});
