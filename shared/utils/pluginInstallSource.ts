/**
 * The label the install progress banner names an install by: the archive's file
 * name for a local install, or the URL for a remote one. The URL loses its query
 * and fragment — a signed download link carries its token there, and the banner
 * is on screen for anyone to read.
 */
export function describePluginInstallSource(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    try {
      const url = new URL(pathOrUrl);
      return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      // Unparseable: fall through and treat it as a path.
    }
  }
  const trimmed = pathOrUrl.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/**
 * A catalog entry's repository as the plugin manager names it (#16779):
 * `github.com/{owner}/{repo}`, the scheme dropped like the banner's URLs.
 */
export function describeCatalogRepo(repo: string): string {
  return repo.replace(/^https:\/\//i, "");
}
