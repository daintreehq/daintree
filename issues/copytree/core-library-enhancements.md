# CopyTree Core: Smart Truncation & Constraints

## Context
As projects grow, generating a full context tree (`copytree`) can easily exceed the context window of AI agents. Simply failing or arbitrarily cutting off files is not a good developer experience. We need a "smart truncation" strategy in the core `copytree` library.

## Goal
Update the `copytree` library to support strict size budgets while prioritizing the most relevant files.

## Proposed Features

### 1. Smart Truncation Strategies
Introduce a `truncationStrategy` option:
*   `none` (Default): Process all matching files. Fail or warn if limits are exceeded.
*   `newest_first`: Sort files by modification time (descending). Add files until `maxTotalSize` is reached.
*   `priority_list` (Future): Allow specific ordering based on usage/frequency (out of scope for v1).

### 2. Forced Constraints
*   **`forceInclude` (Globs):** Patterns that *must* be included, regardless of age (unless they alone exceed the budget). These get top priority in the bucket.
*   **`forceExclude` (Globs):** Patterns to explicitly ignore (already largely supported, but ensure precedence).

### 3. File Truncation (Per-File)
*   **`maxFileSize`:** Hard limit for a single file.
*   **`truncateLargeFiles`:** Boolean.
    *   If `true`: Files larger than `maxFileSize` are included but truncated (head/tail/snippet) with a placeholder message `[... truncated 4MB ...]`.
    *   If `false`: Files larger than `maxFileSize` are skipped entirely.

### 4. Dry-Run / Plan API
*   Add a `plan()` or `dryRun()` method that returns:
    *   List of files that *would* be included.
    *   List of files dropped due to truncation.
    *   Estimated total size.
    *   This is essential for the UI "Test" button.

## Implementation Details
*   Modify the file collection phase to gather metadata first.
*   Apply sorting and filtering based on the selected strategy.
*   Calculate running totals before reading full content (where possible).
*   Ensure `forceInclude` items bypass the "age" filter but still respect the absolute hard limit.

## Deliverables
*   Updated `copytree` package (published/pushed to develop).
*   Unit tests for:
    *   Newest-first sorting.
    *   Force-include priority.
    *   Size budget enforcement.
