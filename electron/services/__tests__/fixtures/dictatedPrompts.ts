/**
 * Dictated agent prompts as the transcriber returns them, each with the
 * cleanup it should get. The guard tests check every expected cleanup is one
 * the meaning guard lets through, and the opt-in live eval
 * (VoiceCleanup.eval.integration.test.ts) judges the real prompt against them.
 *
 * `expected` lists every acceptable result. Comparison ignores case and prose
 * punctuation but not words, word order, or how the text is split into lines.
 */
export interface DictatedPromptCase {
  name: string;
  raw: string;
  expected: readonly string[];
}

export const DICTATED_PROMPTS: readonly DictatedPromptCase[] = [
  {
    name: "fillers and a stutter",
    raw: "Um, so can you, uh, can you figure out why the build is failing on Windows?",
    expected: [
      "Can you figure out why the build is failing on Windows?",
      "So can you figure out why the build is failing on Windows?",
    ],
  },
  {
    name: "a self-correction with no wait",
    raw: "Use the old API, no wait, the new one for the session refresh.",
    expected: ["Use the new one for the session refresh."],
  },
  {
    name: "a retracted sentence",
    raw: "Add a retry around the fetch call. Actually, scratch that. Add a timeout to the fetch call instead.",
    expected: ["Add a timeout to the fetch call instead."],
  },
  {
    name: "a corrected name with I mean",
    raw: "Rename the helper to formatDate, I mean formatDateTime, and update all the callers.",
    expected: ["Rename the helper to formatDateTime and update all the callers."],
  },
  {
    name: "a corrected name with sorry",
    raw: "Check the useAuth hook, sorry, the useSession hook, it's returning stale data after logout.",
    expected: ["Check the useSession hook, it's returning stale data after logout."],
  },
  {
    name: "a correction with or rather",
    raw: "Move the toast into the dock, or rather into the status bar, and keep it there until the job finishes.",
    expected: ["Move the toast into the status bar and keep it there until the job finishes."],
  },
  {
    name: "a correction with a bare no",
    raw: "Put the new setting under general, no, under the terminal section.",
    expected: ["Put the new setting under the terminal section."],
  },
  {
    name: "a negation kept beside a correction",
    raw: "Don't touch the migration files, I mean the seed files, just regenerate the fixtures.",
    expected: ["Don't touch the seed files, just regenerate the fixtures."],
  },
  {
    name: "a retracted number left as spoken",
    raw: "Set the request timeout to 30 seconds, no wait, 60 seconds.",
    expected: ["Set the request timeout to 30 seconds, no wait, 60 seconds."],
  },
  {
    name: "a retracted negation left as spoken",
    raw: "Don't run the full test suite, no wait, run it, but only on the CI box.",
    expected: ["Don't run the full test suite, no wait, run it, but only on the CI box."],
  },
  {
    name: "a false start",
    raw: "I want you to, let's add a debounce to the search input. It should wait 300 milliseconds before firing and cancel any request that's still in flight.",
    expected: [
      "Let's add a debounce to the search input. It should wait 300 milliseconds before firing and cancel any request that's still in flight.",
    ],
  },
  {
    name: "a counted list with ordinals",
    raw: "There are three things to fix. First, the login form doesn't validate emails. Second, the error toast never closes. And third, the dark mode colors are off on the settings page.",
    expected: [
      "There are three things to fix:\n1. The login form doesn't validate emails.\n2. The error toast never closes.\n3. The dark mode colors are off on the settings page.",
    ],
  },
  {
    name: "a list counted one, two, three",
    raw: "Can you do a few things? One, add a loading state to the submit button. Two, disable it while the request is in flight. And three, show an inline error if it fails.",
    expected: [
      "Can you do a few things:\n1. Add a loading state to the submit button.\n2. Disable it while the request is in flight.\n3. Show an inline error if it fails.",
    ],
  },
  {
    name: "numbered steps",
    raw: "Step one, pull the latest develop. Step two, rebase this branch onto it. Step three, run the type check and push.",
    expected: [
      "1. Pull the latest develop.\n2. Rebase this branch onto it.\n3. Run the type check and push.",
    ],
  },
  {
    name: "a list inside a longer prompt",
    raw: "Um, the settings dialog has two bugs. First, the, uh, the search box loses focus after every keystroke. And second, the reset button doesn't clear the modified bar. Can you fix both and add a test for each?",
    expected: [
      "The settings dialog has two bugs:\n1. The search box loses focus after every keystroke.\n2. The reset button doesn't clear the modified bar.\nCan you fix both and add a test for each?",
    ],
  },
  {
    name: "an inline series that is not a list",
    raw: "Update the parser, the lexer and the printer so they handle the new pipe syntax.",
    expected: ["Update the parser, the lexer and the printer so they handle the new pipe syntax."],
  },
  {
    name: "first used as an ordinary word",
    raw: "The first time the page loads the sidebar flickers, can you find out why?",
    expected: ["The first time the page loads the sidebar flickers, can you find out why?"],
  },
  {
    name: "actually used as an ordinary word",
    raw: "The test is actually passing locally, so I think it's a timing issue on CI.",
    expected: [
      "The test is actually passing locally, so I think it's a timing issue on CI.",
      "The test is passing locally, so I think it's a timing issue on CI.",
    ],
  },
  {
    name: "references, code and flags around filler",
    raw: "Um, in @src/components/Toolbar.tsx, uh, rename the `isOpen` prop to `expanded` and run npm test with --watch.",
    expected: [
      "In @src/components/Toolbar.tsx, rename the `isOpen` prop to `expanded` and run npm test with --watch.",
    ],
  },
  {
    name: "misheard technical terms",
    raw: "The type script build is slow, can you check whether veet is re-bundling the whole mono repo on every save?",
    expected: [
      "The TypeScript build is slow, can you check whether Vite is re-bundling the whole monorepo on every save?",
    ],
  },
  {
    name: "like kept, you know dropped",
    raw: "Make the empty state look like the one in settings, you know, with the icon and the short description.",
    expected: [
      "Make the empty state look like the one in settings, with the icon and the short description.",
    ],
  },
  {
    name: "a question cleaned, never answered",
    raw: "Why does the worktree dashboard, uh, re-render every time a terminal prints output?",
    expected: ["Why does the worktree dashboard re-render every time a terminal prints output?"],
  },
];
