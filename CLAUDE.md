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

Pushing is not the last step when the userscript changed — see below.

## Release when the userscript changed

Push to `main` triggers CI only. A **release** — which is how every installed
copy of the userscript auto-updates — fires solely on a `v*` tag. So a fix that
changes the userscript and stops at `git push` never reaches anyone.

**If your change alters `web/avalon-farm.user.js`, bump the version and tag it.**
That is anything under `web/src/` or the build itself, since the script is built
from those. Do it in the same push as the fix, not as a follow-up.

`web/package.json` is the single source of truth: `build.mjs` stamps its version
into the userscript's `@version`, and Tampermonkey compares exactly that field to
decide whether to update. Bumping `package.json` without rebuilding ships a
release nobody installs.

```sh
cd web && npm version <new> --no-git-tag-version && npm run build && npm test
cd .. && git add -A && git commit -m "build: release <new> with <what changed>"
git pull --rebase && git push && git tag v<new> && git push origin v<new>
```

Choose the bump by what the user would notice, while the project is pre-1.0:

- **patch** (`0.3.0` → `0.3.1`) — bug fix, nothing new.
- **minor** (`0.3.0` → `0.4.0`) — a new capability, or changed behavior someone
  running the old script would notice.

Skip the release for changes that cannot reach the built script — docs,
`PROGRESS.md`, CI config, tests. When you skip, say so in your report, so a
silent no-release is never mistaken for an oversight.

Verify the release actually ran rather than assuming the tag was enough:

```sh
gh run list --limit 3
```

## Backlog

Work is queued as GitHub issues assigned to the repo owner, prioritized with the
`p0`..`p5` labels (`p0` highest). Run `/next` to take the top item; it works one
issue, closes it, and stops. Queue new asks with `gh issue create` or the web UI —
add a `p*` label, and **assign it**, or `/next` will not see it.
