# Estimating a run

Read when the user asks how long the run or the drain will take.

Work from this run's measured throughput, not issue counts alone: issues landed per hour, and the time from a pick to its batch's last landing. With nothing measured yet, these are the measures from 2026-10-22 (16 issues on two workers, run one batch at a time):

| Step | Time |
|---|---|
| Pick (`/next-batch`) | about 12 minutes |
| Sync, create worktrees, launch | about 12 minutes |
| `/work`, first to last unit | 25 minutes to 2 hours, average about 75 minutes |
| CI gate and tidy | about 5 minutes |
| `/merge-prs`, 16 PRs in trains | about 45 minutes |
| One whole batch, one at a time, measured end to end | about 2 h 50 m |

The flow hides the pick and the merge, so while there are enough ready issues to keep every slot busy, throughput is about the slot count over the average `/work` time: 20 slots at 75 minutes is about 16 issues an hour.

Then say what bounds it:

- **By count:** open issues ready to work, divided by that throughput.
- **By dependencies:** a chain needs one agent-plus-merge cycle per wave (its slowest agent plus a merge, about 2 h 45 m), whatever the batch size, because a wave starts only once the one before it has merged. The longest chain (a tracker issue's wave table, or the pick's Deferred list) sets the floor. The estimate is the larger of the two.
- **New issues:** count issues filed since the run started, closed ones included (`gh issue list --repo <owner>/<repo> --state all --search "created:>=<run start, YYYY-MM-DD>" --limit 1000 --json number,createdAt,state`, then filter by `createdAt`). When they arrive faster than the run closes them (33 arrived while one 16-issue batch was worked), the drain has no end in sight: say so.
- **Usage:** a machine scaled down or out on its weekly limit (SKILL.md, Usage limits) runs fewer slots until its reset, and a run held on usage makes no progress until then: count the slots that can actually run.
- **Never picked:** issues waiting on a human answer, and tracker issues, don't count.
