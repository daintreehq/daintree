/** Preserve the pre-v11 SDK's collection policy instead of adopting its broader defaults. */
export function buildSentryDataCollection() {
  const piiKeys = ["forwarded", "-ip", "remote-", "via", "-user"];
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: { deny: piiKeys }, response: { deny: piiKeys } },
    httpBodies: [],
    urlQueryParams: { deny: piiKeys },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    graphQL: { document: false, variables: false },
    queues: false,
    frameContextLines: 7,
  };
}
