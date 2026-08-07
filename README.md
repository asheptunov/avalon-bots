# avalon-bots

Bots for the browser MMO [Avalon](https://avalon.juanandresleon.com): farming,
navigation, and a multi-character swarm.

Everything lives in **[`web/`](web/)** — see [`web/README.md`](web/README.md) for
install, usage, and design notes.

**Install the userscript:**
[avalon-farm.user.js](https://github.com/asheptunov/avalon-bots/releases/latest/download/avalon-farm.user.js)
(needs [Tampermonkey](https://www.tampermonkey.net/)). It drives the character in
your open tab — no credentials, and it coexists with you playing, because it
rides the socket the page already opened rather than opening a second one the
server would reject.

**Run headless:**

```sh
cd web && npm install
node src/cli/main.js farm --account <name> --hunt rat
```

## Repo layout

```
web/src/core/       transport-agnostic bot logic (protocol, nav, farm, swarm)
web/src/transport/  browser (hooks the page's socket) | node (opens its own)
web/src/cli/        headless CLI
web/test/           170 tests
.github/workflows/  CI on push; tagged releases publish the userscript
```

Credentials are read from `~/.avalon/creds.json` and are deliberately kept
outside the repo.
