# metafactory-cortex-agent-escort

**The canonical sample of a *deterministic* cortex agent bundle.** Escort is an
onboarding greeter with one job: when a stranger @-mentions it on a bound
public channel, it opens them a private thread, walks them through the three
things a person checks before letting them all the way in, answers questions,
waits — then **hands off to a human**. It never welcomes anyone itself and
never grants a role.

Where [`example-agent`](https://github.com/the-metafactory/example-agent) is
the **minimal teaching chassis** (greet/echo/gate, deliberately no real job),
this pack is a complete, live-deployed agent built on that chassis — the shape
to copy when you want a real deterministic agent, packaged and delivered the
way meta-factory.ai delivers agents. See [Provenance](#provenance) for where
it runs today.

---

## The three brain classes — and where this pack sits

A cortex agent's *brain* is whatever process answers the wire protocol. The
ecosystem taxonomy names three classes:

| Class | What answers | Sample |
|---|---|---|
| **deterministic** | pure rules — no model call anywhere; every reply is written by hand and every effect is code-audited | **this pack** |
| **LLM-hosted** | the host runs a model session as the brain (e.g. a claude-code substrate agent) | [example-non-deterministic](https://github.com/the-metafactory/metafactory-cortex-agent-example-non-deterministic) |
| **hybrid** | an exec brain that *calls* a model for language but keeps effects in code | [example-hybrid](https://github.com/the-metafactory/metafactory-cortex-agent-example-hybrid) |

Deterministic is the right class for an agent that faces **anonymous
strangers**: there is no prompt to inject into, no tool loop to widen, and the
complete behaviour fits in one reviewable file
([`brain/handler.ts`](./brain/handler.ts)). The trade-off is equally plain —
canned replies, keyword triggers, no free conversation. When you need
language, you move to hybrid and keep the effect discipline below.

## Terminology (cortex ubiquitous language)

| Term | Meaning here |
|------|--------------|
| **principal** | the human who installs and runs the pack on their stack |
| **agent** | the stable, long-lived runtime identity. Its `id` (`escort`) addresses it and scopes its runtime — **the id is contract; it never changes per principal** |
| **assistant** | the *named being* the agent hosts — the persona + the display name. **"The name is config, never contract"** — yours to choose (see below) |
| **capability** | the routable ability the agent declares (here: `escort.greet`) |
| **effect** | one line the brain writes back to the host — the *only* way it acts on the world |

Two principals install this same pack and run "Escort" and "Warden" — same
agent id, different assistants. Nothing downstream may depend on the display
name.

## The closed effect universe — "surfaces, never grants"

The escort's boundary is the reason this repo exists as a sample. The brain
can do exactly four things: open a private thread for the triggering
stranger, post text into the conversation it is already in, drop one canned
readiness note into its own bound back-office channel (`post_log` — see
"Back-office notification" below), and terminate its own task with a
`result`. It cannot grant a role, pick a channel to post into (`post` and
`post_log` both carry no channel field — the host decides each target),
ping a raw API, or ask the principal to approve something — **not because it
is told not to, but because there is no effect in its wire protocol that does
any of those things.**

Three structural facts, each checked in code:

1. **The effect set is closed.** [`brain/protocol.ts`](./brain/protocol.ts)
   defines the full brain→host vocabulary. The handler only ever emits
   `post`, `post_log` (from the readiness path alone), and
   `create_private_thread`, plus the terminal `result` — the tests assert
   this over the entire effect *stream*, hostile input included, and assert
   that `result` summaries and `post_log` texts are canned literals that
   never carry message text.
2. **`post` and `post_log` carry no address.** `PostEffect` has only
   `task_id` + `text` — the *host* decides where a task's replies land — and
   `PostLogEffect` likewise names no channel: the host derives its one
   possible target from the agent's own `logChannelId` binding
   (cortex#2206's host-derived-target pattern, second consumer). There is no
   field to point somewhere else even if the code wanted to.
3. **Thread membership is source-derived, never text-derived.** The only
   `members` value ever constructed is the literal `"source"` (the triggering
   user). Message text is read solely to pick a canned reply — it is never
   interpolated into an effect's structural fields.

This is the pattern to copy: when an agent faces untrusted input, make the
unwanted action **structurally impossible**, not policy-forbidden. A persona
paragraph saying "never grant roles" is advice to a model; a protocol with no
grant effect is physics.

Granting membership is a human act (or a separate, trusted skill's job) —
never this pack's.

## Conversation model — every turn is its own task

Found in live deployment: under the real cortex host, every inbound
@-mention — the first hello on the bound channel AND every later reply inside
the onboarding thread — arrives as its **own brain task** (a fresh `task_id`
on a durable JetStream envelope with explicit acks). The host never delivers
follow-up thread messages as `message` events on the original task;
`onMessage` survives only as a thin compatibility delegate for cortex's
normative protocol shape.

Three consequences, all load-bearing:

1. **Every processed task terminates with exactly one `result`** — that is
   what acks the bus envelope. A task that never results hits the host's
   per-task liveness timeout and REDELIVERS (observed live: the same mention
   reprocessed several times, and unacked in-flight zombies starving a
   genuinely new message). The thread-creation task's result follows the
   greeting post (the host pauses the liveness timer during the async
   create, so the gap is safe); a rejected thread request terminates
   `failed`.
2. **Sessions outlive tasks.** A newcomer's onboarding session spans many
   tasks; it lives in the agent-state work_item (keyed by the task_id that
   *opened* it, read from the DB on every event), never in any single task's
   lifetime.
3. **`onTask` routes by thread context**, on host-provided fields only: the
   task's `source.thread` matching the session's host-resolved thread id →
   an in-thread conversational turn (guidance / readiness / patient hold,
   replying on the new task); channel context with a live session → the
   polite duplicate pointer; no session → new onboarding. (Cortex normalizes
   `thread = threadId ?? channelId`, so a top-level mention carries the
   channel id there.)

## The openOnboarding anon-gate

By default cortex refuses strangers: an unmapped sender gets "I'm not set up
to respond to you." A greeter is useless behind that door, so
[`agent.yaml`](./agent.yaml) sets:

```yaml
openOnboarding: true
openOnboardingAllowedTools: []
```

`openOnboarding` lets an unmapped stranger's first mention on the agent's
**bound public channel** through — under a **zero-authority anonymous
principal**. The gate fires only for a non-DM message on the bound channel; an
unmapped DM stays denied, and `dmOwner: false` means the escort never claims
DMs at all.

`openOnboardingAllowedTools: []` is the matching half: the anon session's tool
allowlist, empty on purpose, mirroring `persona.md`'s `allowedTools: []`
exactly. An exec brain has no tool loop, so there is genuinely nothing here to
widen — the tightest possible fit between what is declared and what exists.

## Pack layout

```
arc-manifest.yaml   type: agent, tier: community, targets: [cortex],
                     state: {blueprint: agent-state}, lifecycle postinstall
agent.yaml          → {configRoot}/agents.d/escort.yaml   (the fragment)
persona.md          → {configRoot}/personas/escort.md      (default persona)
config.example.env  copy → ~/.config/metafactory/escort/.env (your overlay)
brain/
  main.ts           daemon socket shell (auth → decode events ⇄ write effects)
  handler.ts        events → effects: the escort's actual behaviour
  protocol.ts       minimal cortex-brain/v1 + create_private_thread (cortex#2206)
  state.ts          agent-state persistence — the DB-authoritative
                     read-through store, the memory-only degraded mode,
                     and dashboard regen (see "State" below)
  config.ts         resolves the principal's chosen name + persona
  env.ts            loads the principal's overlay .env
scripts/
  signal-cortex-reload.sh   postinstall step 1 — cortex agents reload
  scaffold-state.sh         postinstall step 2 — instance state (optional, soft-skips)
test/
  handler.test.ts   drives the brain, asserts the exact effect stream
  state.test.ts     persistence: transitions write rows, restart continuity,
                     external writes visible without restart,
                     duplicate-mention pointer, missing/dying-DB degradation
```

Note what is *absent*, on purpose: no `issue-nats-creds.sh`. The escort runs
`runtime.mode: in-process` — it rides its stack's single signing identity and
is not bus-sovereign, so there is no per-agent NATS credential to mint
(compare `example-agent` and `onboarding-tender`, whose packs do mint one).

## Install

**With arc:**

```bash
arc install metafactory-cortex-agent-escort
```

This drops the fragment + persona into the cortex host's `agents.d/` +
`personas/` dirs and runs the lifecycle postinstall scripts (reload, then the
optional state scaffold).

**Hand-drop** (no arc):

```bash
PACK=~/.config/metafactory/pkg/repos/metafactory-cortex-agent-escort
mkdir -p "$PACK" && cp -R . "$PACK"
cp agent.yaml   ~/.config/cortex/agents.d/escort.yaml
cp persona.md   ~/.config/cortex/personas/escort.md
cortex agents reload
```

The fragment's `persona: ../personas/escort.md` path is written for the
**installed** location (cortex resolves it relative to the fragment's own
directory, and the fragment is installed verbatim — never rewritten), which is
why the two files must land beside each other as above.

## Wiring the Discord surface

`agent.yaml`'s `presence.discord` block carries **placeholders only** — no
token or platform id is ever stored in the pack:

| Placeholder / env var | What it is |
|---|---|
| `ESCORT_BOT_TOKEN` | the escort's own Discord bot token (its own app — never reuse another bot's) |
| `ESCORT_GUILD_ID` | the guild (server) id |
| `ESCORT_AGENT_CHANNEL_ID` | the bound public entry channel — where strangers first mention the escort |
| `ESCORT_LOG_CHANNEL_ID` | the private back-office channel — the `post_log` target (see below) |

They resolve at cortex config-load from the daemon environment. **An unset
placeholder fails soft**: the Discord surface stays disabled and the rest of
the stack still boots — that is cortex's placeholder-resolution behaviour, not
code in this pack.

### Discord application setup — the three things that bite

Learned in the live deployment; get these right and the rest is smooth:

1. **Message Content Intent must be ON** (Discord developer portal → Bot →
   Privileged Gateway Intents). The shared cortex Discord adapter requires it
   to read message text; with it off the bot connects and hears nothing
   useful.
2. **Invite with least privilege.** The escort needs exactly: **View
   Channels**, **Send Messages**, **Create Private Threads**, **Send Messages
   in Threads**. Explicitly **NOT Manage Roles** — the whole design premise is
   that this bot *cannot* grant anything, and that must hold at the platform
   permission layer too, not just in the protocol.
3. **The mention-gate: the adapter only delivers @-mentions** — in channels
   AND inside threads. A newcomer who replies in their private thread without
   @-mentioning the bot is silently unheard. The escort's welcome copy spells
   this out to the newcomer (see `buildThreeThingsCopy` in
   [`brain/handler.ts`](./brain/handler.ts)) — keep that paragraph if you
   customise the copy, or your first real newcomer will conclude the bot
   ignored them.

## Choose your own name & persona

Identity is a **principal-owned overlay resolved at brain startup**, never
baked into the repo — so `arc upgrade` and clean reinstalls never clobber your
choices:

```bash
mkdir -p ~/.config/metafactory/escort
cp config.example.env ~/.config/metafactory/escort/.env
$EDITOR ~/.config/metafactory/escort/.env      # set ESCORT_DISPLAY_NAME
# optional: drop your own persona
$EDITOR ~/.config/metafactory/escort/persona.md
cortex agents reload
```

Resolution order (first hit wins), in [`brain/config.ts`](./brain/config.ts):

- **name** — `ESCORT_DISPLAY_NAME` (env or your overlay `.env`) → pack default
- **persona** — `ESCORT_PERSONA` (explicit path) →
  `~/.config/metafactory/escort/persona.md` → the pack's `persona.md`

## State (optional): an agent that remembers

Agents are stateless by default — delete the `state:` block from
[`arc-manifest.yaml`](./arc-manifest.yaml) and you have exactly the pack that
existed before it. Declaring it opts the escort into the metafactory memory
module: on install, `scripts/scaffold-state.sh` delegates to the
[agent-state](https://github.com/the-metafactory/agent-state) bundle, which
lays down a per-instance home:

```
~/.config/cortex/agents/escort/
├── state.sqlite     work_items (queue) + events (append-only diary)
├── dashboard.md     human-readable status
├── retros/          weekly retrospective summaries
├── context/         scope notes
└── CLAUDE.md        instance bridge for substrate sessions
```

The step **soft-skips** if the bundle isn't installed — the pack installs
cleanly either way.

**The DB is authoritative, read per event** (v0.4.0). The brain holds no
long-lived in-memory session map: every mention asks `state.sqlite` "does
this user have an open onboarding NOW?" and routes on the answer. The
practical consequence: **external writes take effect on the member's next
mention, no restart required** — resolving an item with the errands CLI,
resetting a stuck onboarding, or any other edit made to the DB from another
process is picked up by the running daemon immediately. Back-office tooling
built on agent-state (e.g.
[`metafactory-skill-guild-steward`](https://github.com/the-metafactory/metafactory-skill-guild-steward))
therefore acts without restarts as of this version.

**What the escort records there** ([`brain/state.ts`](./brain/state.ts)): each
newcomer's onboarding is one `work_item` of kind `onboarding` (id = the
task_id that opened it), its status mirroring the session phase within
agent-state's constrained vocabulary:

| Session phase | work_item status | Meaning |
|---|---|---|
| `thread_requested` | `pending` | thread asked for, `thread_created` not yet back |
| `in_thread` | `in_flight` | private thread open, walk-through underway |
| `surfaced` | `waiting_human` | newcomer says they're ready — a HUMAN takes it from here |

Every transition appends an `event` (append-only audit trail), and
`dashboard.md` is best-effort regenerated after each change via agent-state's
own `RegenerateDashboard` workflow — a live back-office view of who's in a
thread and who's waiting for a welcome. The engaged heuristic (the "look done
/ look not done yet" hedge in the surfacing note) is a `turns` counter in the
work_item's notes JSON, bumped once per conversational turn through the
annotate discipline — so it survives restarts too. No message text is ever
stored: the only persisted values are host-provided ids (task/user/thread),
each length-capped and kept inside JSON columns, plus that integer counter —
nothing user-authored can reach the dashboard.

**The durable-vs-transient line.** Durable MEMBER state — who has an open
onboarding, its phase, its thread, its turn count — lives in the DB and only
the DB. The one piece of session-ish process memory left in the brain is
`pendingThreads`: the in-flight correlation between a `create_private_thread`
effect and its `thread_created`/`effect_rejected` answer, keyed by task_id —
per-task effect plumbing scoped to one round-trip, not member state. If the
process dies, the correlation dies with it and the `pending` row it leaves
behind is an orphan. Orphans are cleaned two ways (both keyed on "is there a
live correlation for this row?"): a boot sweep on the host's `hello` resolves
them `failed` so the dashboard never shows phantom pendings, and a lazy guard
at read time does the same if one is ever encountered mid-run — so a crash
between thread request and ack can never permanently block a user; their next
mention retries fresh. Restarts need no rehydration step at all: the next
event's DB read finds whatever is open. The DB opens in WAL mode with a busy
timeout, so external tools can write concurrently while the brain reads.

**Resolving a surfaced item.** A `surfaced` work_item stays open at
`waiting_human` — the escort never closes it. After saying the welcome,
resolve it with agent-state's errands CLI:

```bash
MF_INSTANCE_DIR=~/.config/cortex/agents/escort \
  bun <agent-state>/skill/scripts/errands.ts resolve --id <task-id> --status done
```

The resolve is live immediately: the member's next mention starts a fresh
onboarding (and until then, their duplicate mentions keep getting the polite
pointer). The same goes for any reset performed directly on the DB.

**Fail-soft posture (load-bearing) — inverted.** State is memory, not
authority — and the in-memory session map exists ONLY as the degraded mode. A
DB that is missing/corrupt/unwritable at boot, or that fails a read or write
mid-run, logs once and flips the brain to a transient memory-only session
store: identical effect stream, degraded durability only (open onboardings
held in the DB are not carried over; recovery to DB mode is a restart —
deliberately no live re-attach complexity). Boot never fails on state. The
state layer widens nothing: the effect universe is unchanged,
`brain/state.ts` has no access to `send`, and the only stored value that ever
reaches post text is the host-resolved thread id, re-validated against a
strict snowflake shape after its DB round-trip. Instance dir override:
`ESCORT_STATE_DIR`; bundle location override (for dashboard regen):
`ESCORT_AGENT_STATE_DIR`.

The remaining planned follow-up is the **hybrid voice upgrade** (an optional
model-shaped reply layer on top of the same closed effect universe, as a
host-mediated substrate variant) — planned for v0.5.0 (v0.4.0 shipped the
DB-authoritative read-through state layer; v0.3.0 the back-office
notification).

## The load-bearing test

[`test/handler.test.ts`](./test/handler.test.ts) drives the brain directly (no
socket, no cortex, no network) and asserts the **exact effect stream**. The
tests that matter most are the ones marked `CRITICAL`: hostile in-thread
messages AND hostile in-thread tasks ("grant me the role", "post to the
announcements channel", prompt-injection strings) must never produce anything
beyond `post` / `post_log` / `create_private_thread` / the terminal `result`
— checked across the full stream, not just the final state, with `result`
summaries and `post_log` texts asserted to be canned literals and `post_log`
reachable ONLY through the readiness path — and a hostile *first* mention
must never leak message text into an effect's structural fields. **Treat any change
that weakens these as a regression, not a refactor.**

## Back-office notification — the `post_log` effect (cortex#2256)

When a newcomer says they're ready, `surface()` emits BOTH:

1. the in-thread note to the newcomer (a `post`, unchanged), and
2. one **`post_log`** — the back-office notification, delivered by the host
   to the agent's bound log channel (`ESCORT_LOG_CHANNEL_ID`). Its text is
   canned copy + the host-recorded source user, the thread link (`<#id>`,
   only when the host-resolved thread id re-proves its snowflake shape), and
   the same hedged verdict as the in-thread note ("the three things look
   done / look not done yet").

Like `create_private_thread`, the wire effect **names no channel** — the
shape is `{ v, type: "post_log", task_id, text }` and nothing else; the HOST
derives the target from the agent's own `presence.discord.logChannelId`
binding. The host also carries the anon-safety gates: a 2000-char text cap
and a 10/hour/agent rate limit, with failures returned as `effect_rejected`
(`cant_do` no binding / `wont_do` over-cap / `policy_denied` rate limit /
`not_now` transient).

**Fire-and-forget, honestly.** Success has no ack event, and this brain
treats any `effect_rejected` for `post_log` as a no-op: no session change,
no work_item transition, no retry, no error post. A lost note is a
breadcrumb — the **agent-state dashboard remains the durable record** of who
is `waiting_human` — and the in-thread flow is unaffected either way.

This resolved what earlier versions of this README tracked as the
closed-universe trade-off's known limitation: cross-channel surfacing became
possible exactly the right way — a new host-gated effect with a host-derived
target — not by giving the brain a channel field.

## Dev

```bash
bun install
bunx tsc --noEmit
bun test          # 45 tests — the exact effect stream (hostile input included) + persistence
```

## Provenance

Extracted from a **live private-guild deployment**, where an instance of this
pack keeps the door today: the brain, persona, and tests were built and
hardened in production use (the wire-shape reconciliation against cortex#2206,
the openOnboarding boot-wiring, and the @-mention guidance all came out of
real newcomers walking through the real door). That private copy remains the
deployment source of truth; **this repo is the genericized, marketplace-facing
sample** — the shape of the bundle, not the deployment itself. The
`create_private_thread` effect it depends on shipped in
[cortex#2206](https://github.com/the-metafactory/cortex/issues/2206), and the
`post_log` effect behind the back-office notification shipped in
[cortex#2256](https://github.com/the-metafactory/cortex/issues/2256). The
chassis (socket shell, env/config overlay, protocol skeleton) comes from
[`example-agent`](https://github.com/the-metafactory/example-agent).

## License

MIT — see [LICENSE](./LICENSE).
