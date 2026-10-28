/**
 * Resolves a plugin artifact playback request (#14100): the artifact's file,
 * pinned until `unpin`, when `lease` was minted for it and both are live.
 */
export type ArtifactSourceResolver = (
  artifactId: string,
  lease: string
) => { filePath: string; mimeType: string; unpin: () => void } | null;

// Module-scoped so the protocol handlers registered once at startup see the
// artifact service as it comes and goes (#10331): `protocol.handle` freezes
// its closure. Its own module so the plugin service can install it without
// importing the protocol layer.
let resolver: ArtifactSourceResolver | null = null;

export function setArtifactSourceResolver(next: ArtifactSourceResolver | null): void {
  resolver = next;
}

export function getArtifactSourceResolver(): ArtifactSourceResolver | null {
  return resolver;
}
