// Total keyterms sent per dictation, across dictionary, project, repository,
// workspace names, commands, branch and terminal: the dictionary's 36 plus the reserve.
export const MAX_KEYTERMS = 74;

// Slots the dictionary can never take, so project (4), repository (6),
// workspace names (12), command (12) and branch (4) terms always fit.
export const RESERVED_CONTEXT_KEYTERMS = 38;

export const MAX_DICTIONARY_KEYTERMS = MAX_KEYTERMS - RESERVED_CONTEXT_KEYTERMS;

// Host, project and worktree names the user speaks aloud, sent beside the dictionary.
export const MAX_NAME_KEYTERMS = 12;
