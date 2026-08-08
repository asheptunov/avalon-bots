---
description: Pick up the highest-priority open issue assigned to you and work it to completion
allowed-tools: Bash(gh:*), Bash(git:*), Read, Write, Edit, Glob, Grep
---

Work the next item off this repository's GitHub issue queue.

Take exactly **one** issue, complete it, close it, and stop. Do not continue to a
second issue — the user runs `/next` again in a fresh session when they are ready.

## 1. Select the issue

The queue is the open issues **assigned to the authenticated user** in whatever
repository the working directory belongs to. Never hardcode a repo; let `gh`
resolve it from the git remote.

Priority is the `p0`..`p5` labels, `p0` highest. GitHub cannot sort by label, so
walk the tiers in order and take the **oldest** issue in the first tier that has
one:

```sh
gh issue list --state open --assignee @me --label p0 \
  --search "sort:created-asc" --limit 1 --json number,title,body,labels,url
```

Repeat for `p1`, `p2`, `p3`, `p4`, `p5`, stopping at the first non-empty result.
If every tier is empty, fall back to the oldest open issue assigned to the user
with no `p*` label at all.

`gh issue list` has **no `--sort` flag** — ordering only works through
`--search "sort:created-asc"`, as above. Without it `gh` returns newest-first and
the queue runs backwards, so keep the search term even though it looks redundant.

Report and **stop** without changing anything if:

- there are no open issues assigned to the user — say the queue is empty;
- `gh` is not authenticated or the directory has no GitHub remote — say which.

If open issues exist but none are assigned to the user, say so explicitly and
name a couple of them. That usually means the user forgot to assign, and silently
doing unassigned work is worse than asking.

Announce the issue you picked — number, title, priority — before starting work.

## 2. Understand it

Read the issue body and every comment (`gh issue view <n> --comments`). Later
comments may narrow, redirect, or contradict the original body; the most recent
instruction from the user wins.

Explore the code before editing. If the issue is genuinely ambiguous — two
plausible readings that lead to materially different work — ask the user rather
than guessing. If it is merely underspecified, make the call a careful colleague
would make and state the assumption in your report.

## 3. Do the work

Implement the change. Follow the repository's own conventions and any `CLAUDE.md`
guidance in scope, including its rules about testing and what must pass before a
commit — those live with the repo, not in this command.

Commit when the work is done and the repo's checks pass. Reference the issue in
the commit subject so the history links back:

```
fix: split the eat/cook/stack selector (#1)
```

Do not push unless the user asks.

## 4. Close it out

Comment on the issue with a short account of what changed and the commit SHA,
then close it:

```sh
gh issue close <n> --comment "<what changed, and the commit sha>"
```

Keep the comment to a few lines — what changed, where, and anything the user
should verify by hand. It is the permanent record of how the ask was resolved,
and the user gives follow-up feedback in that same thread.

If you could **not** finish, do not close the issue. Comment with where you got
to and what blocked you, and say so in your report.

## 5. Report and stop

Tell the user: which issue you took, what you changed, whether the repo's checks
passed, and what remains open in the queue (count by priority tier). Then stop —
do not start the next issue.
