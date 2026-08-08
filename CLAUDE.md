# avalon-bots

Bots for the browser MMO Avalon. All code lives under `web/` — see
`web/README.md` for design notes and `PROGRESS.md` for running status.

## Before you commit

The gate for this repo is **tests, and nothing heavier**. Do not run reviewer
subagents or `/code-review` here unless asked for explicitly — they are not part
of the gate and they burn tokens this project would rather spend on the work.

1. **Cover the change with tests.** If the change is behavioral, there must be a
   test that fails without it. Extend an existing test file when one fits rather
   than adding a new one.
2. **Add a regression test when fixing a bug.** It must reproduce the bug — see
   it fail before the fix, pass after. A fix without a failing-first test is not
   done.
3. **The suite must be green.**

   ```sh
   cd web && npm test
   ```

4. If a change genuinely cannot be tested — a build script, docs, a userscript
   header — say so plainly in your report instead of skipping the step quietly.

The bots drive a live third-party game server. There is no staging environment,
so the test suite is the only thing standing between a refactor and a broken
character in production. Treat a red suite as a hard stop.

## Push when you are done

**In this repo, push without asking.** This overrides the global rule that
`git push` is opt-in — it applies here and nowhere else. Once the gate above
passes and the work is committed, land it:

```sh
git pull --rebase && cd web && npm test && git push
```

Re-run the suite after the rebase, not just before it. A clean rebase can still
produce a broken tree when someone else's commit touched the same code, and that
is precisely the breakage worth catching before it reaches `origin/main`.

**Stop and hand it back if the rebase conflicts.** Do not resolve conflicts to
get the push through. Leave the rebase in progress or abort it, say which you
did, and report what conflicted — a wrong resolution here ships a broken bot with
no staging environment to catch it.

Push to `main` triggers CI (`.github/workflows/ci.yml`) but does **not** publish
a release. Releases fire only on a `v*` tag, so never push a tag unless asked.

## Backlog

Work is queued as GitHub issues assigned to the repo owner, prioritized with the
`p0`..`p5` labels (`p0` highest). Run `/next` to take the top item; it works one
issue, closes it, and stops. Queue new asks with `gh issue create` or the web UI —
add a `p*` label, and **assign it**, or `/next` will not see it.
