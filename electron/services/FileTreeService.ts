import * as fs from "fs/promises";
import * as path from "path";
import { simpleGit } from "simple-git";
import type { FileTreeNode } from "../../shared/types/ipc.js";

export class FileTreeService {
  async getFileTree(basePath: string, dirPath: string = ""): Promise<FileTreeNode[]> {
    const resolvedBasePath = path.resolve(basePath);

    if (path.isAbsolute(dirPath)) {
      throw new Error("Invalid directory path: absolute paths not allowed");
    }

    const normalizedDirPath = path.normalize(dirPath);
    const normalizedForCheck = normalizedDirPath.replace(/\\/g, "/");
    if (
      normalizedForCheck === ".." ||
      normalizedForCheck.startsWith("../") ||
      normalizedForCheck.includes("/../")
    ) {
      throw new Error("Invalid directory path: path traversal not allowed");
    }

    const relativeDirPath =
      normalizedForCheck === "." ? "" : normalizedForCheck.replace(/^\.\/+/, "");
    const targetPath = path.resolve(resolvedBasePath, relativeDirPath);
    const relativeTarget = path.relative(resolvedBasePath, targetPath);

    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      throw new Error("Invalid directory path: path traversal not allowed");
    }

    try {
      const resolvedBaseRealPath = await fs
        .realpath(resolvedBasePath)
        .catch(() => resolvedBasePath);
      const targetRealPath = await fs.realpath(targetPath).catch(() => targetPath);
      const relativeRealTarget = path.relative(resolvedBaseRealPath, targetRealPath);
      if (relativeRealTarget.startsWith("..") || path.isAbsolute(relativeRealTarget)) {
        throw new Error("Invalid directory path: path traversal not allowed");
      }

      const stats = await fs.stat(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }

      const entries = await fs.readdir(targetPath, { withFileTypes: true });

      const toGitPath = (p: string) => p.split(path.sep).join("/");
      const pathsToCheck = entries.map((e) => toGitPath(path.join(relativeDirPath, e.name)));
      const ignoredPaths = new Set<string>();

      try {
        const git = simpleGit(resolvedBasePath);
        if (pathsToCheck.length > 0) {
          const ignored = await git.checkIgnore(pathsToCheck);
          ignored.forEach((p) => ignoredPaths.add(toGitPath(p)));
        }
      } catch (_e) {
        // ignore
      }
      const nodes: FileTreeNode[] = [];

      for (const entry of entries) {
        const relativePath = path.join(relativeDirPath, entry.name);
        const gitRelativePath = toGitPath(relativePath);
        const absolutePath = path.join(resolvedBasePath, relativePath);

        if (entry.name === ".git") {
          continue;
        }

        if (ignoredPaths.has(gitRelativePath)) {
          continue;
        }

        const fileStat = await fs.lstat(absolutePath);
        const isSymlink = fileStat.isSymbolicLink();

        if (isSymlink) {
          continue;
        }

        const isDirectory = fileStat.isDirectory();
        let size = 0;

        if (!isDirectory) {
          try {
            size = fileStat.size;
          } catch {
            continue;
          }
        }

        nodes.push({
          name: entry.name,
          path: relativePath,
          isDirectory,
          size,
          children: undefined,
        });
      }

      nodes.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      return nodes;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`Failed to read directory tree: ${error.message}`);
      }
      throw new Error(`Failed to read directory tree: ${String(error)}`);
    }
  }
}

export const fileTreeService = new FileTreeService();
