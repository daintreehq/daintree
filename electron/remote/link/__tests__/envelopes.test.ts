import { describe, expect, it } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import type { AppErrorDetails } from "../../../../shared/types/appError.js";
import { appErrorEnvelope, linkErrorEnvelope, unwrapEnvelope } from "../envelopes.js";

const details = {
  code: "PLUGIN_INCOMPATIBLE",
  pluginId: "acme.x",
  hostId: "box",
  reason: { kind: "engine", required: ">=2", hostVersion: "1.0.0" },
} satisfies AppErrorDetails;

const TOKEN = `ghp_${"a".repeat(36)}`;

describe("linkErrorEnvelope", () => {
  it("applies the packaged sanitiser policy to everything it sends", () => {
    const cause = new Error("inner at /Users/alice/repo/secret.ts");
    const error = new AppError({
      code: "PLUGIN_INCOMPATIBLE",
      message: `open /Users/alice/repo/.env failed with ${TOKEN}`,
      userMessage: `Could not read /home/bob/notes.txt (${TOKEN})`,
      context: { repo: "/Users/alice/repo", token: TOKEN },
      details,
      cause,
    });
    Object.assign(error, { path: "/Users/alice/repo/.env", extra: "/Users/alice/x" });

    const envelope = linkErrorEnvelope(error);
    const sent: Record<string, unknown> = { ...envelope.error };
    const wire = JSON.stringify(sent);

    expect(wire).not.toContain("/Users/alice");
    expect(wire).not.toContain("/home/bob");
    expect(wire).not.toContain(TOKEN);
    expect(sent.stack).toBeUndefined();
    expect(sent.path).toBeUndefined();
    expect(sent.context).toBeUndefined();
    expect(sent.cause).toBeUndefined();
    expect(sent.properties).toBeUndefined();
    expect(sent.code).toBe("PLUGIN_INCOMPATIBLE");
    expect(sent.details).toEqual(details);
    expect(String(sent.message)).toContain("<path>");
  });

  it("scrubs plain errors thrown by a reverse handler", () => {
    const envelope = linkErrorEnvelope(new Error(`EACCES /private/var/tmp/x key=${TOKEN}`));
    expect(JSON.stringify(envelope)).not.toContain("/private/var");
    expect(JSON.stringify(envelope)).not.toContain(TOKEN);
  });

  it("keeps typed codes readable on the other side", () => {
    const thrown = (() => {
      try {
        unwrapEnvelope(appErrorEnvelope("HOST_DISCONNECTED", "closed", "The host went away."));
      } catch (err) {
        return err as { code?: string; userMessage?: string; message: string };
      }
      return undefined;
    })();
    expect(thrown?.code).toBe("HOST_DISCONNECTED");
    expect(thrown?.userMessage).toBe("The host went away.");
    expect(thrown?.message).toBe("closed");
  });
});
