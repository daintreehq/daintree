export type ProjectType = "node" | "python" | "rust" | "go" | "generic";

export async function detectProjectType(projectPath: string): Promise<ProjectType> {
  const markers: Array<[string[], ProjectType]> = [
    [["package.json"], "node"],
    [["pyproject.toml", "requirements.txt"], "python"],
    [["Cargo.toml"], "rust"],
    [["go.mod"], "go"],
  ];

  for (const [files, type] of markers) {
    for (const file of files) {
      const result = await window.electron.files.search({
        cwd: projectPath,
        query: file,
        limit: 10,
      });
      if (result.files.length > 0) {
        return type;
      }
    }
  }

  return "generic";
}

export function generateClaudeMdTemplate(type: ProjectType): string {
  switch (type) {
    case "node":
      return `# Project Guidelines

## Tech Stack
- **Runtime**: Node.js / TypeScript
- **Package Manager**: Check \`package.json\` for the package manager and available scripts

## Common Commands
- \`npm install\` — Install dependencies
- \`npm run dev\` — Start development server
- \`npm test\` — Run tests
- \`npm run build\` — Build for production

## Coding Conventions
- Follow existing code style (check for \`.eslintrc\`, \`.prettierrc\`, or config in \`package.json\`)
- Write tests alongside new features
- Prefer TypeScript strict mode
`;

    case "python":
      return `# Project Guidelines

## Tech Stack
- **Language**: Python
- **Package Manager**: Check for \`pyproject.toml\`, \`requirements.txt\`, or \`Pipfile\`

## Common Commands
- \`pip install -r requirements.txt\` — Install dependencies
- \`python -m pytest\` — Run tests
- \`python -m ruff check .\` — Lint code
- \`python -m ruff format .\` — Format code

## Coding Conventions
- Follow PEP 8 style guide
- Use type hints where possible
- Keep functions small and focused
`;

    case "rust":
      return `# Project Guidelines

## Tech Stack
- **Language**: Rust
- **Build Tool**: Cargo

## Common Commands
- \`cargo build\` — Build the project
- \`cargo test\` — Run tests
- \`cargo run\` — Run the binary
- \`cargo clippy\` — Lint code
- \`cargo fmt\` — Format code

## Coding Conventions
- Follow Rust idioms and ownership patterns
- Use \`Result\` and \`Option\` for error handling
- Prefer safe Rust over \`unsafe\` blocks
`;

    case "go":
      return `# Project Guidelines

## Tech Stack
- **Language**: Go
- **Build Tool**: Go modules

## Common Commands
- \`go build ./...\` — Build all packages
- \`go test ./...\` — Run all tests
- \`go run .\` — Run the main package
- \`gofmt -w .\` — Format code
- \`go vet ./...\` — Check for issues

## Coding Conventions
- Follow Go conventions (gofmt, naming, error handling)
- Return errors explicitly rather than panicking
- Keep packages focused and minimal
`;

    default:
      return `# Project Guidelines

## Overview
Describe the project's purpose and main goals here.

## Tech Stack
List the main technologies, frameworks, and tools used.

## Common Commands
- Add build, test, and run commands here

## Coding Conventions
- Describe coding style, naming conventions, and patterns to follow
- Add any architectural decisions or constraints
`;
  }
}
