import { commandService } from "../CommandService.js";
import { githubCreateIssueCommand } from "./githubCreateIssue.js";

export function registerCommands(): void {
  commandService.register(githubCreateIssueCommand);
}
