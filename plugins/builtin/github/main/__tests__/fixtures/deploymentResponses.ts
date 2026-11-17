/**
 * GitHub GraphQL responses to `BRANCH_DEPLOYMENTS_QUERY` and
 * `PR_DEPLOYMENTS_QUERY`, recorded from public repositories using Vercel
 * previews (#17248). Project names, branch names and preview hosts are renamed
 * and `rateLimit` is dropped; ids, SHAs, timestamps, states and the response
 * shape are as GitHub returned them.
 */

/** PR whose newer head-commit preview went inactive while an earlier push's stays active; the head deployment is also in the timeline. */
export const PR_ACTIVE_AND_INACTIVE = {
  repository: {
    pullRequest: {
      headRefName: "feature/verbose-setup",
      isCrossRepository: false,
      commits: {
        nodes: [
          {
            commit: {
              oid: "ac051e068c5c4076eb85a66c9237376d05354d2d",
              deployments: {
                nodes: [
                  {
                    id: "DE_kwDOGKvm488AAAABzgHF5w",
                    commitOid: "ac051e068c5c4076eb85a66c9237376d05354d2d",
                    environment: "Preview – docs",
                    state: "INACTIVE",
                    createdAt: "2026-11-12T22:18:35Z",
                    updatedAt: "2026-11-12T22:18:35Z",
                    ref: null,
                    latestStatus: {
                      state: "INACTIVE",
                      environmentUrl: "https://docs-lwslo8huj.vercel.app",
                      createdAt: "2026-11-12T22:18:35Z",
                      updatedAt: "2026-11-12T22:18:35Z",
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      timelineItems: {
        nodes: [
          {
            deployment: {
              id: "DE_kwDOGKvm488AAAABzegibA",
              commitOid: "34d1ff2e4a05d552d8eacefb60c2f89f79147fec",
              environment: "Preview – docs",
              state: "ACTIVE",
              createdAt: "2026-11-12T20:59:48Z",
              updatedAt: "2026-11-12T20:59:49Z",
              ref: null,
              latestStatus: {
                state: "SUCCESS",
                environmentUrl: "https://docs-hbr9phk9i.vercel.app",
                createdAt: "2026-11-12T20:59:49Z",
                updatedAt: "2026-11-12T20:59:49Z",
              },
            },
          },
          {
            deployment: {
              id: "DE_kwDOGKvm488AAAABzgHF5w",
              commitOid: "ac051e068c5c4076eb85a66c9237376d05354d2d",
              environment: "Preview – docs",
              state: "INACTIVE",
              createdAt: "2026-11-12T22:18:35Z",
              updatedAt: "2026-11-12T22:18:35Z",
              ref: null,
              latestStatus: {
                state: "INACTIVE",
                environmentUrl: "https://docs-lwslo8huj.vercel.app",
                createdAt: "2026-11-12T22:18:35Z",
                updatedAt: "2026-11-12T22:18:35Z",
              },
            },
          },
        ],
      },
    },
  },
};

/** PR whose previews failed on two pushes; only the newer one is on the head commit. */
export const PR_FAILED_ACROSS_PUSHES = {
  repository: {
    pullRequest: {
      headRefName: "dependabot/npm_and_yarn/deps-9ea22ff7bb",
      isCrossRepository: false,
      commits: {
        nodes: [
          {
            commit: {
              oid: "7c374c599f4404adf5a65210ac99e99776194eb9",
              deployments: {
                nodes: [
                  {
                    id: "DE_kwDOIuCgE88AAAAB09I9GQ",
                    commitOid: "7c374c599f4404adf5a65210ac99e99776194eb9",
                    environment: "Preview – web",
                    state: "FAILURE",
                    createdAt: "2026-11-17T09:03:58Z",
                    updatedAt: "2026-11-17T09:03:58Z",
                    ref: null,
                    latestStatus: {
                      state: "FAILURE",
                      environmentUrl: "https://web-raxw7r5ee-acme.vercel.app",
                      createdAt: "2026-11-17T09:03:58Z",
                      updatedAt: "2026-11-17T09:03:58Z",
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      timelineItems: {
        nodes: [
          {
            deployment: {
              id: "DE_kwDOIuCgE88AAAABzY13lQ",
              commitOid: "0f5bf0027085400eeaa3e0247661c0b85ca5bce4",
              environment: "Preview – web",
              state: "FAILURE",
              createdAt: "2026-11-12T16:45:49Z",
              updatedAt: "2026-11-12T16:45:50Z",
              ref: null,
              latestStatus: {
                state: "FAILURE",
                environmentUrl: "https://web-iyiqbfsm3-acme.vercel.app",
                createdAt: "2026-11-12T16:45:50Z",
                updatedAt: "2026-11-12T16:45:50Z",
              },
            },
          },
          {
            deployment: {
              id: "DE_kwDOIuCgE88AAAAB09I9GQ",
              commitOid: "7c374c599f4404adf5a65210ac99e99776194eb9",
              environment: "Preview – web",
              state: "FAILURE",
              createdAt: "2026-11-17T09:03:58Z",
              updatedAt: "2026-11-17T09:03:58Z",
              ref: null,
              latestStatus: {
                state: "FAILURE",
                environmentUrl: "https://web-raxw7r5ee-acme.vercel.app",
                createdAt: "2026-11-17T09:03:58Z",
                updatedAt: "2026-11-17T09:03:58Z",
              },
            },
          },
        ],
      },
    },
  },
};

/** Branch whose tip commit carries one failed preview, recorded against the commit (`ref: null`). */
export const BRANCH_FAILED = {
  repository: {
    ref: {
      target: {
        oid: "7c374c599f4404adf5a65210ac99e99776194eb9",
        deployments: {
          nodes: [
            {
              id: "DE_kwDOIuCgE88AAAAB09I9GQ",
              commitOid: "7c374c599f4404adf5a65210ac99e99776194eb9",
              environment: "Preview – web",
              state: "FAILURE",
              createdAt: "2026-11-17T09:03:58Z",
              updatedAt: "2026-11-17T09:03:58Z",
              ref: null,
              latestStatus: {
                state: "FAILURE",
                environmentUrl: "https://web-raxw7r5ee-acme.vercel.app",
                createdAt: "2026-11-17T09:03:58Z",
                updatedAt: "2026-11-17T09:03:58Z",
              },
            },
          ],
        },
      },
    },
  },
};

/** Branch that exists on the remote with nothing deployed at its tip. */
export const BRANCH_NO_DEPLOYMENTS = {
  repository: {
    ref: {
      target: {
        oid: "cc47f25c07c34ac4d17192fce5f768e3e857dca0",
        deployments: {
          nodes: [],
        },
      },
    },
  },
};

/** Branch the remote doesn't have: GitHub resolves `ref` to null without an error. */
export const BRANCH_MISSING = {
  repository: {
    ref: null,
  },
};

/** Raw GraphQL envelope for a PR number that doesn't exist: partial data plus a NOT_FOUND error at `repository.pullRequest`. */
export const PR_MISSING_ENVELOPE = {
  data: {
    repository: {
      pullRequest: null,
    },
  },
  errors: [
    {
      type: "NOT_FOUND",
      path: ["repository", "pullRequest"],
      locations: [
        {
          line: 4,
          column: 7,
        },
      ],
      message: "Could not resolve to a PullRequest with the number of 99999999.",
    },
  ],
};
