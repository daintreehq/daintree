// Total keyterms sent per dictation, across dictionary, project, repository, branch and terminal.
export const MAX_KEYTERMS = 50;

// Slots the dictionary can never take, so project, repository and branch terms always fit.
export const RESERVED_CONTEXT_KEYTERMS = 14;

export const MAX_DICTIONARY_KEYTERMS = MAX_KEYTERMS - RESERVED_CONTEXT_KEYTERMS;
