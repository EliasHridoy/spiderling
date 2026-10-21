# Contributing

Thanks for helping. Spiderling is small enough to hold in your head: read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first (ten minutes) and you will know where
anything belongs.

## Set up

```bash
git clone https://github.com/EliasHridoy/spiderling.git
cd spiderling
npm install
npm test            # compiles, then runs every test (Node 22+)
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded
(`.vscode/launch.json`); `npm run watch` recompiles on save. Open a folder in the dev host,
run an agent in it, and watch.

| Script | |
| --- | --- |
| `npm run compile` / `npm run watch` | Build `src/` into `out/` |
| `npm test` | Compile and run `test/*.test.js` with Node's built-in runner |
| `npm run lint:types` | Type-check only |
| `npm run package` | Build `spiderling-<version>.vsix` with `vsce` |
| `node scripts/render-screenshots.js` | Regenerate `docs/images/*.png` from the demo trace (needs Chrome/Chromium) |
| `node examples/make-demo-trace.js` | Regenerate `examples/demo-trace.json` |

## Ground rules

- **No `vscode` import under `src/transcript/`, and none in `media/traceAnalysis.js`.**
  That is what keeps the capture and analysis layers testable in plain Node and the
  analysis reusable in the browser.
- **Look at real logs before writing a parser, and parse defensively.** The agents' log
  formats are undocumented and change. Check every field, skip what you do not understand,
  never throw on bad input, and note the agent version you looked at.
- **Synthetic fixtures only.** Real logs contain private code and prompts. Build records in
  the observed shapes (see `test/helpers.js`); never commit a real log, trace or screenshot
  of a real project.
- **Tests with the change.** A bug fix gets a test that fails without it. Run the parser or
  analysis over every real log you have as a smoke test and look at the numbers, not only
  at green checks.
- **Say what is verified.** In a PR description, separate what you ran from what you did not
  (for example "not run in a real VS Code window").
- **Comments explain why**, not what; match the surrounding style.
- Do not add a dependency without a reason; there are no runtime dependencies today, and
  that is a feature.

## Adding an agent

See [docs/AGENT_SUPPORT.md](docs/AGENT_SUPPORT.md#adding-an-agent): a source, a parser,
tests, docs.

## Pull requests

1. Branch from `main`, keep the change focused.
2. `npm test` passes; update the README / docs / `CHANGELOG.md` when behaviour changes.
3. Describe what changed and why, how you checked it, and what you did not check.

## Releasing (maintainers)

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
3. The **Release** workflow runs the tests, builds the VSIX, attaches it to a GitHub
   Release, and publishes to the Marketplace and Open VSX when the `VSCE_PAT` /
   `OVSX_PAT` repository secrets are set.

To publish to the Marketplace for the first time: create a publisher at
<https://marketplace.visualstudio.com/manage>, make sure `publisher` in `package.json`
matches its id, create an Azure DevOps personal access token with the *Marketplace →
Manage* scope, and add it as the `VSCE_PAT` secret.
