import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isImage, main, publishDecision, pullToken, readManifest } from "./host-image-registry.mjs";

const repository = "daintreehq/daintree-host";
const imageId = `sha256:${"a".repeat(64)}`;
const otherId = `sha256:${"a".repeat(63)}b`;
const credentials = { GHCR_USER: "bot", GHCR_TOKEN: "secret" };
const image = {
  schemaVersion: 2,
  mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  config: { digest: imageId },
  layers: [],
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** A manifest as GHCR serves it, with the digest of exactly these bytes. */
function manifestResponse(manifest, digestOverride) {
  const bytes = JSON.stringify(manifest);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    digest,
    response: new Response(bytes, {
      status: 200,
      headers: { "docker-content-digest": digestOverride ?? digest },
    }),
  };
}

/** A registry answering each request in turn, remembering what it was asked. */
function registry(...answers) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request to ${url}`);
    return answer;
  };
  return { fetchImpl, seen };
}

const token = () => json(200, { token: "issued" });

describe("readManifest", () => {
  it.each([["MANIFEST_UNKNOWN"], ["NAME_UNKNOWN"]])(
    "reads a 404 saying only %s as no such tag, from one authenticated GET",
    async (code) => {
      const { fetchImpl, seen } = registry(json(404, { errors: [{ code }] }));
      await expect(
        readManifest({ repository, reference: "1.2.3", bearer: "t", fetchImpl })
      ).resolves.toEqual({ found: false });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        url: `https://ghcr.io/v2/${repository}/manifests/1.2.3`,
        method: "GET",
      });
      expect(seen[0].headers.authorization).toBe("Bearer t");
      // Without OCI types in Accept, GHCR answers 404 for an OCI manifest that's there.
      expect(seen[0].headers.accept.split(", ").sort()).toEqual([
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
      ]);
    }
  );

  it.each([
    ["a 404 without the registry's error document", new Response("Not Found", { status: 404 })],
    ["a 404 with no errors listed", json(404, { errors: [] })],
    ["a 404 for another reason", json(404, { errors: [{ code: "BLOB_UNKNOWN" }] })],
    [
      "a 404 that also refuses access",
      json(404, { errors: [{ code: "MANIFEST_UNKNOWN" }, { code: "DENIED" }] }),
    ],
    ["a refusal", json(403, { errors: [{ code: "DENIED" }] })],
    ["an unauthorized token", json(401, { errors: [{ code: "UNAUTHORIZED" }] })],
    ["rate limiting", json(429, { errors: [{ code: "TOOMANYREQUESTS" }] })],
    ["a server error", new Response("upstream", { status: 503 })],
  ])("throws on %s rather than call the tag free", async (_label, answer) => {
    const { fetchImpl } = registry(answer);
    await expect(
      readManifest({ repository, reference: "1.2.3", bearer: "t", fetchImpl })
    ).rejects.toThrow(/GHCR answered/);
  });

  it("returns the digest of the bytes it was served, and the manifest", async () => {
    const { digest, response } = manifestResponse(image);
    const { fetchImpl } = registry(response);
    await expect(
      readManifest({ repository, reference: "1.2.3", bearer: "t", fetchImpl })
    ).resolves.toEqual({ found: true, digest, manifest: image });
  });

  it.each([
    ["no digest", null, /no digest/],
    ["a truncated digest", `sha256:${"c".repeat(63)}`, /no digest/],
    ["a digest of other bytes", `sha256:${"c".repeat(64)}`, /but its bytes are/],
  ])("throws when a found manifest comes with %s", async (_label, header, error) => {
    const bytes = JSON.stringify(image);
    const headers = header ? { "docker-content-digest": header } : {};
    const { fetchImpl } = registry(new Response(bytes, { status: 200, headers }));
    await expect(
      readManifest({ repository, reference: "1.2.3", bearer: "t", fetchImpl })
    ).rejects.toThrow(error);
  });
});

describe("publishDecision and isImage", () => {
  const params = { repository, version: "1.2.3", imageId };

  it("pushes a version the registry has no tag for", () => {
    expect(publishDecision({ found: false }, params)).toBe("push");
  });

  it("finds a rerun's own push there and doesn't push again", () => {
    expect(publishDecision({ found: true, digest: "d", manifest: image }, params)).toBe("pushed");
  });

  it.each([
    ["another image", { ...image, config: { digest: otherId } }],
    // Whatever it carries, an index isn't the one image this workflow pushes.
    ["an index", { ...image, mediaType: "application/vnd.oci.image.index.v1+json" }],
  ])("refuses a version that already holds %s", (_label, manifest) => {
    expect(() => publishDecision({ found: true, digest: "d", manifest }, params)).toThrow(
      /already exists.*published once/
    );
  });

  it("matches one image by its whole config digest, in either manifest format", () => {
    expect(isImage(image, imageId)).toBe(true);
    expect(
      isImage({ ...image, mediaType: "application/vnd.oci.image.manifest.v1+json" }, imageId)
    ).toBe(true);
    expect(isImage(image, otherId)).toBe(false);
  });
});

describe("pullToken", () => {
  it("asks for a pull token with the credentials it has, and as anyone without", async () => {
    const withCredentials = registry(token());
    await expect(
      pullToken({ repository, user: "bot", token: "secret", fetchImpl: withCredentials.fetchImpl })
    ).resolves.toBe("issued");
    expect(withCredentials.seen).toEqual([
      {
        url: `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
        method: "GET",
        headers: { authorization: `Basic ${Buffer.from("bot:secret").toString("base64")}` },
      },
    ]);

    const anonymous = registry(json(200, { token: "public" }));
    await expect(pullToken({ repository, fetchImpl: anonymous.fetchImpl })).resolves.toBe("public");
    expect(anonymous.seen[0].headers).toEqual({});
  });

  it.each([
    ["a refusal that still carries a token", json(403, { token: "issued" }), /no token/],
    ["no token", json(200, {}), /had no token/],
    ["a token that isn't a string", json(200, { token: 42 }), /had no token/],
  ])("throws on %s", async (_label, answer, error) => {
    await expect(pullToken({ repository, fetchImpl: registry(answer).fetchImpl })).rejects.toThrow(
      error
    );
  });
});

describe("the workflow's commands", () => {
  async function run(argv, ...answers) {
    const { fetchImpl, seen } = registry(...answers);
    const outputs = {};
    const reports = [];
    const run = main(argv, {
      env: credentials,
      fetchImpl,
      output: (name, value) => (outputs[name] = value),
      report: (line) => reports.push(line),
    });
    return { run, outputs, reports, seen };
  }

  it("check says to push a free version, and authenticates both requests", async () => {
    const {
      run: result,
      outputs,
      seen,
    } = await run(
      ["check", repository, "1.2.3", imageId],
      token(),
      json(404, { errors: [{ code: "MANIFEST_UNKNOWN" }] })
    );
    await expect(result).resolves.toBe(0);
    expect(outputs).toEqual({ push: "true" });
    expect(seen[0].headers.authorization).toMatch(/^Basic /);
    expect(seen[1].headers.authorization).toBe("Bearer issued");
  });

  it("check says not to push a version already holding this image", async () => {
    const { run: result, outputs } = await run(
      ["check", repository, "1.2.3", imageId],
      token(),
      manifestResponse(image).response
    );
    await expect(result).resolves.toBe(0);
    expect(outputs).toEqual({ push: "false" });
  });

  it("check fails a version holding another image, and says nothing", async () => {
    const { run: result, outputs } = await run(
      ["check", repository, "1.2.3", otherId],
      token(),
      manifestResponse(image).response
    );
    await expect(result).rejects.toThrow(/published once/);
    expect(outputs).toEqual({});
  });

  it("resolve gives the digest only for the tested image", async () => {
    const { digest, response } = manifestResponse(image);
    const good = await run(["resolve", repository, "1.2.3", imageId], token(), response);
    await expect(good.run).resolves.toBe(0);
    expect(good.outputs).toEqual({ digest });

    const other = await run(
      ["resolve", repository, "1.2.3", otherId],
      token(),
      manifestResponse(image).response
    );
    await expect(other.run).rejects.toThrow(/doesn't hold the image this run tested/);
    expect(other.outputs).toEqual({});
  });

  it.each([
    ["a version with a prefix", ["check", repository, "v1.2.3", imageId]],
    ["a moving tag", ["check", repository, "latest", imageId]],
    ["an image ID that isn't one", ["check", repository, "1.2.3", "candidate"]],
  ])("refuses %s before asking the registry anything", async (_label, argv) => {
    const { run: result, seen } = await run(argv);
    await expect(result).rejects.toThrow(/Not a/);
    expect(seen).toEqual([]);
  });

  it("anonymous passes a digest anyone can pull, asking without credentials", async () => {
    const { digest, response } = manifestResponse(image);
    const { run: result, seen } = await run(["anonymous", repository, digest], token(), response);
    await expect(result).resolves.toBe(0);
    expect(seen[0].headers).toEqual({});
    expect(seen[1].url).toBe(`https://ghcr.io/v2/${repository}/manifests/${digest}`);
  });

  it("anonymous reports a package it can't pull, with the registry's reason", async () => {
    const { run: result, reports } = await run(
      ["anonymous", repository, `sha256:${"e".repeat(64)}`],
      json(401, { errors: [{ code: "UNAUTHORIZED" }] })
    );
    await expect(result).resolves.toBe(3);
    expect(reports.join("\n")).toMatch(/no token.*401/s);
  });
});
