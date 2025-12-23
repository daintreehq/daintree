# HybridInput: Folder Autocomplete Support

## Problem
The `@` autocomplete in the HybridInput bar currently only suggests files. Users often want to select a specific folder (e.g., to run a command in that directory, or to reference it for an agent), but folder names are not included in the suggestions.

## Current Behavior
- `HybridInputBar` uses `useFileAutocomplete`.
- `useFileAutocomplete` calls `electron.files.search`.
- `FileSearchService` (main process) retrieves file lists.
  - `loadFilesFromDisk`: Explicitly skips adding directories to the results list (`if (entry.isDirectory()) { queue.push(absolute); continue; }`).
  - `loadGitFiles`: Uses `git ls-files`, which lists files only.

## Desired Behavior
- The `@` autocomplete list should include both files and directories.
- Directories should ideally be visually distinct (e.g., appended with `/`).
- Selecting a directory should complete the path (e.g. `@src/components/`).
- **Scoring & Prioritization:** Folder matching should follow the same prioritization logic as files (exact matches first, then basename matches, then fuzzy path matches). See `scorePath` in `FileSearchService.ts`.

## Implementation Details

### 1. Update `FileSearchService.ts`
- **`loadFilesFromDisk`**: Update the traversal logic to include directory paths in the `results` array, not just enqueue them.
- **`loadGitFiles`**: `git ls-files` does not list directories. We may need to:
  - Parse the file list to extract unique directory paths.
  - Or combine `git ls-files` with a shallow `fs.readdir` or `git ls-tree` to get directory structures.
  - *Recommendation:* Post-processing the `git ls-files` output to extract unique dirnames is likely efficient enough for moderate repos, or we can simply accept that `loadGitFiles` is file-centric and perhaps mix in directories from disk if needed. However, since `loadGitFiles` is an optimization, we might need a slightly smarter approach to get folders without walking the whole disk.
  - *Alternative:* Use `git ls-tree -r -d --name-only HEAD` to get directories.

### 2. Update `HybridInputBar` / `AutocompleteMenu`
- Ensure the UI handles the directory items correctly.
- If we append `/` to directories, the filtering logic in `scorePath` might need a slight tweak to handle the trailing slash gracefully (or stripping it for scoring).

## Acceptance Criteria
- Typing `@` followed by a partial folder name suggests matching folders.
- Selecting a folder inserts it into the input (e.g. `@my-folder/`).
- Files within folders are still suggested as before.
- Folders and files are scored and sorted together using the existing relevance algorithm.