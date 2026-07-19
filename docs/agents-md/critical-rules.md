### Repo-specific critical rules

- **The effect-stream security tests are sacred.** `test/handler.test.ts`'s two `CRITICAL` tests (hostile input never widens the effect universe; message text never reaches effect structural fields) define this pack. Any change that weakens their assertions is a regression, not a refactor — do not merge it.
- **This repo is PUBLIC.** No live Discord snowflakes, tokens, or guild-specific identifiers anywhere — `agent.yaml` carries `__ESCORT_*__` placeholders only, and test fixtures use non-numeric placeholder ids. Keep them that way.
- **Do not rewrite ported behaviour.** The pack is extracted from a live private-guild deployment, which remains the deployment source of truth; behavioural drift between the two is a coordinated change, not a drive-by edit.
