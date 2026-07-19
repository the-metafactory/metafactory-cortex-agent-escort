#!/usr/bin/env bash
# Lifecycle postinstall step 2: scaffold the agent's instance state — the
# OPTIONAL memory module declared in arc-manifest.yaml (`state:`).
#
# Delegates to the agent-state bundle's ScaffoldFolders workflow, which lays
# down ~/.config/cortex/agents/escort/{state.sqlite, dashboard.md, context/,
# retros/, CLAUDE.md}. Idempotent — safe on reinstall and upgrade;
# operator-edited files are preserved.
#
# Ordering invariant: runs LAST — state is additive; the agent must be
# registered (step 1) whether or not it remembers.
#
# Soft-skip: agents are stateless by default ("bring your own grounding") and
# this pack must install cleanly without the agent-state bundle. Missing bun
# or missing bundle → skip with a hint. A bundle that IS present but fails to
# scaffold is a real error.
set -euo pipefail

SCAFFOLD="${AGENT_STATE_SCAFFOLD:-$HOME/.config/metafactory/pkg/repos/agent-state/skill/scripts/scaffold.ts}"
INSTANCE_DIR="${MF_INSTANCE_DIR:-$HOME/.config/cortex/agents/escort}"

if ! command -v bun >/dev/null 2>&1; then
  echo "escort postinstall: bun not on PATH — skipping state scaffold (the agent runs stateless; install bun and re-run scripts/scaffold-state.sh to opt in)"
  exit 0
fi

if [ ! -f "$SCAFFOLD" ]; then
  echo "escort postinstall: agent-state bundle not installed — skipping state scaffold (the agent runs stateless; 'arc install agent-state' and re-run scripts/scaffold-state.sh to opt in)"
  exit 0
fi

if bun "$SCAFFOLD" "$INSTANCE_DIR" --host=cortex --agent=escort; then
  echo "escort postinstall: instance state scaffolded at $INSTANCE_DIR — ok"
else
  echo "escort postinstall: state scaffold FAILED" >&2
  exit 1
fi
