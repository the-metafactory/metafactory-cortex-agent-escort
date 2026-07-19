<!-- Generated from metafactory ecosystem template. Customize sections marked with {PLACEHOLDER}. -->

# metafactory-cortex-agent-escort -- the canonical cortex agent bundle (deterministic by default, hybrid by opt-in)

Escort — a cortex onboarding greeter with a closed effect universe, shipped as the canonical sample of how a cortex agent is bundled and delivered on meta-factory.ai. Deterministic by default at the anonymous edge, stack-managed hybrid voice by opt-in (compose, cortex#2257). Exec brain, surfaces to a human, never grants.

## Domain Context

Before doing work in this repo, load the domain language:

- **`./CONTEXT.md`** — this repo's bounded-context glossary, if present. One canonical term per concept, with the aliases to avoid. If you find yourself using a term loosely, check it here first. Every ecosystem repo is expected to grow a `CONTEXT.md` (authored via the `grill-with-docs` skill).
- **`compass/ecosystem/CONTEXT-MAP.md`** — the ecosystem context map: the bounded contexts (soma, cortex, myelin, signal, …) and how their boundary terms reconcile.

When `CONTEXT.md` and your instinct disagree, `CONTEXT.md` wins. When a term crosses a repo boundary, the `CONTEXT-MAP.md` is authoritative.

<!--
  Wire-contract grounding — optional per-repo slot (`wire_grounding`).

  Repos that touch the wire (subject grammar, envelope, identity, transport,
  discovery, admission — the M2–M6 protocol contracts of the Myelin layer model)
  populate this slot with a trigger→RFC routing table so wire-touching work is
  routed to the governing myelin RFC on demand rather than always-loaded. The
  slot renders empty for repos with no wire surface.

  How to populate (per-repo, NOT here): add to the repo's `agents-md.yaml`
      sections:
        - position: "after:domain-context"
          file: docs/agents-md/wire-grounding.md
  and author the trigger→RFC table in that section file. The template owns the
  slot; the repo owns the table content. See compass/standards/domain-grounding.md.
-->
<!-- inject:after:domain-context -->

## Architecture

- `agent.yaml` — the cortex fragment (installed to `agents.d/escort.yaml`; paths written for the INSTALLED location — `persona: ../personas/escort.md`). Ships `runtime.brain.compose: false` — deterministic by default at the anonymous edge; the hybrid voice is a per-deployment opt-in.
- `persona.md` — the doorkeeper character; its `allowedTools: []` MUST mirror `agent.yaml`'s `openOnboardingAllowedTools` exactly. LOAD-BEARING at runtime when a deployment enables the hybrid voice: the host uses it verbatim as the system prompt of every `compose` substrate turn (cortex#2257).
- `brain/` — cortex-brain/v1 exec brain: `main.ts` (socket shell), `handler.ts` (all behaviour), `voice.ts` (the hybrid voice seam — compose/composed correlation, canned-fallback discipline, caps; cortex#2257), `protocol.ts` (wire types incl. `create_private_thread`, cortex#2206, `post_log`, cortex#2256, and `compose`/`composed`, cortex#2257), `state.ts` (DB-authoritative read-through agent-state persistence, memory-only degraded mode), `config.ts` + `env.ts` (principal-overlay identity resolution + the `ESCORT_VOICE` switch).
- `test/handler.test.ts` — 26 tests asserting the exact effect stream, including per-task `result` termination and thread-context routing; `test/voice.test.ts` — 14 tests pinning the hybrid hard rules (byte-identical stream with voice off, canned fallback on every compose failure, model text only in decided post bodies and never in decisions, one result per task, agent.yaml keyless + compose off); `test/state.test.ts` — 19 persistence tests (restart continuity, external writes visible without restart, duplicate-mention pointer, orphaned-pending sweep, memory-only degradation incl. a mid-run DB death).
- `scripts/` — lifecycle postinstall (reload; state scaffold with soft-skip). Deliberately NO nats-creds script: the escort is in-process, not bus-sovereign.

## Gate

Before any commit or PR, run and pass:

```bash
bun install && bunx tsc --noEmit && bun test
```

<!-- inject:after:description -->

## Naming

- **metafactory** -- always lowercase, one word. Not "Metafactory", not "Meta Factory". The GitHub org is `the-metafactory`, the repo name may be hyphenated (technical constraint), and the domains are `meta-factory.ai/.dev/.io` (DNS constraint). But the brand name is always `metafactory`.

## Critical Rules

- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.
- An **"X doesn't exist" claim is an assertion — verify it before acting on it.** Grep is case- and separator-blind: a `response_routing` search silently misses `responseRouting`/`ResponseRouting`. Before concluding a symbol/field/string is absent, prefer **LSP symbol search** (`workspaceSymbol`/`findReferences`), or grep case-insensitively (`-i`) and across snake/camel/Pascal variants. Case-blind greps have caused both a missed-migration cluster and a redundant rebuild of already-shipped code.
- NEVER fabricate file names, class names, or architecture. If unsure, read the source.
- Fix ALL errors found during type checks, tests, or linting -- even if pre-existing or introduced by another developer. Never dismiss errors as "not from our changes." If you see it, fix it.
- **Wrap the substrate — user-facing flows are tool-commands-only.** No onboarding or operational step a person follows should require a raw substrate command (raw `nsc`/`nats-server`, `wrangler`/D1, SQL, low-level `git` plumbing, etc.). If a step needs the substrate, wrap it behind a first-class verb of the tool. A raw substrate command surfacing in an SOP or onboarding step is a **finding, not a step** — a tool exposes its own domain language and never leaks the layer it is built on.
- Before fixing a bug or implementing a feature, ALWAYS check open PRs (`gh pr list`) and issues (`gh issue list`) first. Someone may already be working on it, or there may be a PR ready to merge that addresses it. Don't duplicate work -- review what exists before racing to write code.
- Before merging a PR, verify the branch is up to date with the base branch. If other PRs have merged since the branch was created, rebase or merge base into the branch first. Squash merges on stale branches silently overwrite changes that landed in the interim -- this has caused data loss (PR #120 overwrote real page implementations with stubs).
- Control plane vs data plane: review-style output (PR review, design note, code analysis, decision record) goes to **GitHub** as a full PR/issue comment via `gh pr comment` / `gh issue comment` (or `gh pr review` for formal approvals). Then post a **one-liner in the matching Discord entity thread** (`{repo}/pr/{N}` or `{repo}/issue/{N}`) — verdict, counts, deep link to the GitHub comment. Discord = control plane; GitHub = data plane. See [docs/design-control-vs-data-plane.md](https://github.com/the-metafactory/compass/blob/main/docs/design-control-vs-data-plane.md) for exceptions and rationale.
- **Dual-announce for community-announced repos.** Post **when you land a PR** (on merge) — and on release — keeping development interactive/visible; you need not cut a version release on every PR. Before posting, check whether the repo is **community-announced**. The authoritative, single-source list is the set of repos flagged `community_announce: true` in [`compass/ecosystem/repos.yaml`](https://github.com/the-metafactory/compass/blob/main/ecosystem/repos.yaml) (1:1-linked to meta-factory product repos that are public or shortly becoming public; the list is dynamic — repos join it as they go public, so read the registry, never a hardcoded name list). Post to **the repo's OWN channel** — `#<repo>` (e.g. `#signal` for signal, `#cortex` for cortex, `#myelin`, `#arc`, `#soma`), **never** a fixed channel. Then:
  - **Community-announced repo →** post to that repo's `#<repo>` channel on **BOTH** Discord servers — two `discord` CLI calls:
    - `discord post --channel <repo> "<announcement>"` (the **grove** server, default)
    - `discord post --guild <community-guild-id> --channel <repo> "<announcement>"` (or `--server <community-profile>`) for the **metafactory-community** server
  - **Not community-announced →** post to the **grove** server's `#<repo>` channel only.
  - **No PII or secrets in the community post** — the metafactory-community server is public-facing. The community copy carries the public-safe announcement only; keep internal IDs, principal-private detail, and unreleased specifics out of it.
- **Confidentiality — treat this repo as exposed unless you've confirmed otherwise.** Before every commit, push, or PR (titles included — a leaked term in a PR title is still a leak), self-check: no client or engagement names, phrases, or acronyms/codes derived from them; no real people's identities, emails, or seed data anywhere — including seeds/migrations/fixtures — use placeholders; no live platform IDs (Discord/Slack channel or guild snowflakes, webhook URLs, tokens); deployment-specific config lives in `~/.config/<tool>/` on the machine running the stack, never committed to this repo. Every shippable path (`agents.d/`, `personas/`, `arc-manifest*.yaml`, and anywhere `arc` ships verbatim) carries only `.example`/`<REPLACE_ME>`/zeroed placeholders. Never use a real organization as a doc or code example. See [`compass/standards/data-classification.md`](https://github.com/the-metafactory/compass/blob/main/standards/data-classification.md) for the full class taxonomy and placeholder mapping.

### Repo-specific critical rules

- **The effect-stream security tests are sacred.** `test/handler.test.ts`'s `CRITICAL` tests (hostile input — as in-thread messages AND as per-turn tasks — never widens the effect universe beyond post/post_log/create_private_thread/result; message text never reaches effect structural fields or result summaries) and `test/voice.test.ts`'s hybrid hard-rule pins (voice off ⇒ byte-identical stream; composed text lands only in decided post bodies and never feeds a decision; every compose failure falls back to the exact canned line) define this pack. Any change that weakens their assertions is a regression, not a refactor — do not merge it.
- **This repo is PUBLIC.** No live Discord snowflakes, tokens, or guild-specific identifiers anywhere — `agent.yaml` carries `__ESCORT_*__` placeholders only, and test fixtures use non-numeric placeholder ids (the one exception: deliberately short fake numeric thread ids in `test/state.test.ts`, 9–12 digits where a real snowflake is 17+, because the snowflake-shape validation is itself under test). Keep them that way.
- **Do not rewrite ported behaviour.** The pack is extracted from a live private-guild deployment, which remains the deployment source of truth; behavioural drift between the two is a coordinated change, not a drive-by edit.

<!-- inject:after:critical-rules -->

## GitHub Labels (ecosystem standard)

All metafactory ecosystem repos use a shared label set. Do not create ad-hoc labels.

| Label | Description | Color | Purpose |
|-------|-------------|-------|---------|
| `bug` | Something isn't working | `#d73a4a` | Defect tracking |
| `documentation` | Improvements or additions to documentation | `#0075ca` | Docs work |
| `feature` | Feature specification | `#1D76DB` | Feature work |
| `infrastructure` | Cross-cutting infrastructure work | `#5319E7` | Infra/tooling |
| `now` | Currently being worked | `#0E8A16` | Priority: active |
| `next` | Next up after current work | `#FBCA04` | Priority: queued |
| `future` | Planned but not yet scheduled | `#C5DEF5` | Priority: backlog |
| `handover` | NZ/EU timezone bridge -- work session summary | `#F9D0C4` | Async handoffs |

No project-specific labels — the standard set only.

Every issue must have at least one type label (`bug`, `feature`, `infrastructure`, `documentation`) and one priority label (`now`, `next`, `future`) if open.

## GitHub Issue Tracking
When working on a GitHub issue in this repo, keep the issue updated as you work. This is default agent behavior, not optional.

**On starting work:**
- Comment on the issue: what you're working on.
- Example: `gh issue comment 1 --body "Starting: implement initial project structure"`

**During work:**
- Link every PR to its issue with `Closes #N` in the PR body (or `gh pr create` with an issue reference).
- If the issue body has a flat checkbox list, tick items as you complete them.

**On completing work:**
- Comment with a summary: what was done, what changed, any follow-up needed.
- Merging the PR auto-closes the issue via `Closes #N`. For iteration umbrellas, the sub-issue rollup updates automatically.
- If the issue is not PR-closable (e.g. a tracking or umbrella issue), close it manually once every child is done.

### Iteration umbrellas (sub-issues, not flat checkboxes)

Iterations with more than ~3 slices use GitHub's native **sub-issues**:

```
Iteration umbrella issue (parent)
  ├── sub-issue: slice A feature issue → closed by its PR
  ├── sub-issue: slice B feature issue → closed by its PR
  └── sub-issue: slice C feature issue → closed by its PR
```

- The umbrella links the `iterations/iteration-{n}.md` file in its body. Slice issues are added as sub-issues, not as markdown bullets.
- Each slice is a real issue (assignable, commentable, PR-linkable). Its PR closes it.
- The parent aggregates progress automatically — no manual ticking of nested checkboxes.
- Update both the repo iteration file and the umbrella when slices are added, split, or reprioritised.

**Tooling:** `gh extension install yahsan2/gh-sub-issue` gives `gh sub-issue add <parent> <child>`. Otherwise use the "Sub-issues" section on any issue page or the REST API (`POST /repos/{owner}/{repo}/issues/{n}/sub_issues`).

**Why:** GitHub is the shared collaboration surface. Team members and agents all read it. If you do work but don't update the issue, it looks like nothing happened.

## Standard Operating Procedures

This repo follows ecosystem SOPs defined in [compass](https://github.com/the-metafactory/compass). **Before starting work, identify which SOPs apply and Read them. Output the pre-flight line from each loaded SOP.**

| SOP | Activate when | File |
|-----|--------------|------|
| **Dev pipeline** | Creating branches, making PRs, starting any feature/fix work | `compass/sops/dev-pipeline.md` |
| **Versioning** | After merging PRs, before deploying, any version bump | `compass/sops/versioning.md` |
| **Deployment** | Deploying to dev or production after a release | `compass/sops/deployment.md` |
| **Worktree discipline** | Starting feature work (always — even solo) | `compass/sops/worktree-discipline.md` |
| **Design process** | Creating specs, design docs, or research docs | `compass/sops/design-process.md` |
| **Retrospective** | Post-work review, extracting process patterns | `compass/sops/retrospective-and-process-mining.md` |
| **New repo** | Bootstrapping a new repository in the ecosystem | `compass/metafactory/sops/new-repo.md` |
| **PR review** | Reviewing a PR, before approving or merging | `compass/sops/pr-review.md` |
| **Federation wire protocol** | Writing/reviewing any `federated.*` / cross-principal bus code (subjects, source, originator, deriveNatsSubject, selectLink, peers[], review consumer) | `compass/sops/federation-wire-protocol.md` |
| **Autonomous work** | Driving delegated work unattended (principal asleep/away) — slice loop, review, gate, merge | `compass/sops/autonomous-work.md` |
| **In-session dev loop** | Driving feedback (a walker/tester report) or work to shipped *in-session* — main session diagnoses + verifies + narrates live to the channel; ephemeral sub-agents build + review | `compass/sops/in-session-dev-loop.md` |
| **Security incident response** | Detecting, containing, or investigating a security finding | `compass/metafactory/sops/security-incident-response.md` |

### Examples

**Starting a feature:**
```
Task: "Add a dashboard panel"
→ Activate: dev-pipeline + worktree
→ Read both SOPs
→ Output: "SOP: dev-pipeline | Branch: feat/g-300-panel | Prefix: feat:"
→ Output: "SOP: worktree | Worktree: ../metafactory-cortex-agent-escort-panel | Branch: feat/g-300-panel | Main: untouched"
```

**After merging a PR:**
```
Task: "Merge PR #42"
→ After merge, activate: versioning
→ Read SOP
→ Output: "SOP: versioning | Current: v0.2.0 | Bump: patch → v0.2.1"
```

<!-- inject:after:sop-table -->

## Blueprint-Driven Development

All ecosystem repos track features in `blueprint.yaml`. Before starting feature work, check the dependency graph:

```bash
# What's ready to work on? (dependencies satisfied)
blueprint ready

# Claim a feature
blueprint update escort:{ID} --status in-progress

# After PR merges
blueprint update escort:{ID} --status done
blueprint lint   # Validate graph integrity
```

**Statuses:** Only `planned`, `in-progress`, and `done` are settable. `ready`, `blocked`, and `next` are computed from the dependency graph.

**Cross-repo dependencies:** Use `{repo}:{ID}` format (e.g., `grove:G-200`, `arc:A-100`). A feature is `blocked` if any dependency in another repo isn't `done`.

## Versioning & Releases

See `compass/sops/versioning.md` for the full procedure. Key repo-specific details:

- Version source of truth: `arc-manifest.yaml`
- Release title format: `"metafactory-cortex-agent-escort vX.Y.Z -- Short Description"`
- Deploy command: `arc upgrade metafactory-cortex-agent-escort`
- **Version consistency:** if this repo carries a version in both `arc-manifest.yaml` and `package.json`, the two MUST match — `--version` derives from the manifest, a bump updates both, and CI's `check-version-consistency` gate enforces equality.

<!-- inject:after:versioning -->

## Multi-Agent Worktree Discipline

See `compass/sops/worktree-discipline.md` for the full procedure. Key repo-specific details:

- Worktree directory pattern: `../metafactory-cortex-agent-escort-{slug}`
- Example: `git worktree add ../metafactory-cortex-agent-escort-feature -b feat/{branch-name} main`

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
