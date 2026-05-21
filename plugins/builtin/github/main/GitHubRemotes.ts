import { GitService } from "../../../../electron/services/GitService.js";
import { parseGitHubRepoUrl } from "./GitHubRepoContext.js";

export async function listGitHubRemotes(
  cwd: string
): Promise<
  Array<{ name: string; fetchUrl: string; parsedRepo: { owner: string; repo: string } | null }>
> {
  const gitService = new GitService(cwd);
  const remotes = await gitService.listRemotes(cwd);

  const result = remotes.map((r) => ({
    name: r.name,
    fetchUrl: r.fetchUrl,
    parsedRepo: parseGitHubRepoUrl(r.fetchUrl),
  }));

  result.sort((a, b) => {
    if (a.name === "origin") return -1;
    if (b.name === "origin") return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}
