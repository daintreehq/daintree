/**
 * The fixture's resolver entry, written as an author would against
 * `@daintreehq/plugin-sdk/element-picker` (`defineElementPickerResolver` is an
 * identity function, left out as in `lit.ts`). It checks a stamped position
 * against the file the host read: the line must open the element's tag, as
 * the guest reported it, at the stamped column. Anything else is a mismatch
 * naming what it read, never a guess.
 */
interface Location {
  lineBase: 0 | 1;
  columnBase: 0 | 1;
  columnUnit: "utf16";
  line: number;
  column: number;
}

interface Candidate {
  kind: string;
  candidateId: string;
  framework: string;
  file: string;
  location?: Location | null;
}

interface Observation {
  elementId: string;
  sourceCandidates: Candidate[];
  componentChain: { components: Array<{ sourceCandidates: Candidate[] }> };
  frameworkEvidence: Array<{
    kind: string;
    framework?: string;
    fields?: Array<{ name: string; value: string }>;
  }>;
}

interface FileRef {
  workspaceId: string;
  path: string;
}

type Access<T> = { ok: true; value: T } | { ok: false; reason: string };

interface SourceAccess {
  locateFile(reported: string, signal: AbortSignal): Promise<Access<FileRef>>;
  readSource(
    file: FileRef,
    signal: AbortSignal
  ): Promise<Access<{ file: FileRef; revision: string; bytes: Uint8Array }>>;
}

interface Request {
  requestId: string;
  documentEpoch: number;
  observations: Observation[];
}

const decoder = new TextDecoder();

function tagOf(observation: Observation, providerId: string): string | null {
  for (const evidence of observation.frameworkEvidence) {
    if (evidence.kind !== "generic" || evidence.framework !== providerId) continue;
    const tag = evidence.fields?.find((field) => field.name === "tag")?.value;
    if (tag) return tag;
  }
  return null;
}

async function resolveCandidate(
  candidate: Candidate,
  tag: string | null,
  access: SourceAccess,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const unavailable = (reason: string, extra: Record<string, unknown> = {}) => ({
    state: "unavailable",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    reason,
    ...extra,
  });
  const location = candidate.location;
  if (candidate.kind !== "template-location" || !location || tag === null) {
    return unavailable("unsupported");
  }
  const located = await access.locateFile(candidate.file, signal);
  if (!located.ok) return unavailable(located.reason);
  const read = await access.readSource(located.value, signal);
  if (!read.ok) return unavailable(read.reason);
  const lines = decoder.decode(read.value.bytes).split(/\r?\n/);
  const text = lines[location.line - location.lineBase];
  const at = location.column - location.columnBase;
  if (text === undefined || !text.startsWith(`<${tag}`, at)) {
    return unavailable("mismatch", {
      read: { file: read.value.file, fileRevision: read.value.revision },
    });
  }
  return {
    state: "verified",
    candidateId: candidate.candidateId,
    claim: candidate.kind,
    target: { file: read.value.file, location },
    fileRevision: read.value.revision,
  };
}

export default function createLitResolver(providerId: string) {
  return {
    async resolve(request: Request, access: SourceAccess, signal: AbortSignal) {
      return {
        requestId: request.requestId,
        documentEpoch: request.documentEpoch,
        outcomes: await Promise.all(
          request.observations.map(async (observation) => {
            const tag = tagOf(observation, providerId);
            const candidates = [
              ...observation.sourceCandidates,
              ...observation.componentChain.components.flatMap((record) => record.sourceCandidates),
            ];
            return {
              elementId: observation.elementId,
              results: await Promise.all(
                candidates.map((candidate) => resolveCandidate(candidate, tag, access, signal))
              ),
            };
          })
        ),
      };
    },
  };
}
