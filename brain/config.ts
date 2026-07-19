/**
 * Per-principal IDENTITY resolution — the heart of what makes one pack reusable
 * by many operators.
 *
 * The problem: everyone who installs this pack would otherwise get an agent with
 * the SAME name and persona. That's wrong — each principal should choose their
 * own. The solution: identity is a principal-owned OVERLAY resolved here at brain
 * startup, never baked into the committed repo.
 *
 *   • `id` (in agent.yaml) is STABLE — it addresses the agent and scopes its
 *     NATS creds, so it must not change per principal.
 *   • `displayName` + `persona` are CHOSEN by the installing principal.
 *
 * Resolution order (first hit wins) — a principal customises WITHOUT editing the
 * pack, so `arc upgrade` / clean reinstall never clobber their choices:
 *
 *   displayName:
 *     1. env  ESCORT_DISPLAY_NAME   (cortex stack injects, or the overlay .env)
 *     2. DEFAULT_DISPLAY_NAME (below)
 *
 *   persona file:
 *     1. env  ESCORT_PERSONA        (explicit path)
 *     2. ~/.config/metafactory/escort/persona.md   (principal overlay)
 *     3. <pack>/persona.md                 (shipped default)
 *
 * env vars are populated by loadBrainEnv() (brain/env.ts) from the principal's
 * overlay file before this runs, so the whole chain is file- or stack-driven.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packRoot, principalConfigDir } from "./env";

export const DEFAULT_DISPLAY_NAME = "Escort";

export interface AgentIdentity {
  /** Principal-chosen name; greetings and the persona header use it. */
  displayName: string;
  /** Absolute path of the persona file that won resolution. */
  personaPath: string;
  /** The persona text (empty string if the file is missing/unreadable). */
  personaText: string;
  /** Which layer supplied the persona — for a friendly startup log. */
  personaSource: "env" | "principal-overlay" | "pack-default" | "none";
}

/** Resolve the persona file path + its source, per the order above. */
function resolvePersona(): { path: string; source: AgentIdentity["personaSource"] } {
  const fromEnv = process.env.ESCORT_PERSONA;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    return { path: fromEnv, source: "env" };
  }
  const overlay = join(principalConfigDir(), "persona.md");
  if (existsSync(overlay)) return { path: overlay, source: "principal-overlay" };

  const packDefault = join(packRoot(), "persona.md");
  if (existsSync(packDefault)) return { path: packDefault, source: "pack-default" };

  return { path: packDefault, source: "none" };
}

/** Resolve the full principal-specific identity for this brain instance. */
export function resolveIdentity(): AgentIdentity {
  const nameFromEnv = process.env.ESCORT_DISPLAY_NAME;
  const displayName =
    nameFromEnv !== undefined && nameFromEnv.trim().length > 0
      ? nameFromEnv.trim()
      : DEFAULT_DISPLAY_NAME;

  const { path, source } = resolvePersona();
  let personaText = "";
  if (source !== "none") {
    try {
      personaText = readFileSync(path, "utf-8");
    } catch {
      personaText = "";
    }
  }

  return { displayName, personaPath: path, personaText, personaSource: source };
}
