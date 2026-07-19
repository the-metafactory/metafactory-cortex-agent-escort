/**
 * Env-file loader — fills process.env from a principal-owned file, absent keys
 * only (a host-injected secret still wins).
 *
 * Resolution order (first existing file wins):
 *   1. ESCORT_ENV_FILE (explicit path)
 *   2. ~/.config/metafactory/escort/.env   — the PRINCIPAL-owned overlay
 *   3. <pack>/.env                                 — dev/local default
 *
 * The principal-owned path is the important one: it lets each operator set their
 * own knobs (see config.ts) WITHOUT editing the installed pack, so `arc upgrade`
 * and clean reinstalls never clobber their choices. All three are gitignored.
 *
 * Minimal `KEY=VALUE` parsing: no interpolation, no `export`, `#` comments and
 * blank lines skipped, surrounding quotes stripped. Missing file is a no-op.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Pack root = the dir above brain/ (where agent.yaml + persona.md live). */
export function packRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** The principal-owned config dir: ~/.config/metafactory/escort/. */
export function principalConfigDir(): string {
  return join(homedir(), ".config", "metafactory", "escort");
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/** First existing env-file path in resolution order, or null. */
function resolveEnvFilePath(): string | null {
  const explicit = process.env.ESCORT_ENV_FILE;
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const principal = join(principalConfigDir(), ".env");
  if (existsSync(principal)) return principal;
  const packLocal = join(packRoot(), ".env");
  if (existsSync(packLocal)) return packLocal;
  return null;
}

/**
 * Load the resolved env file into process.env (absent keys only). Returns the
 * path read, or null if none. Logs to stderr — never a value.
 */
export function loadBrainEnv(): string | null {
  const path = resolveEnvFilePath();
  if (path === null) {
    process.stderr.write("escort: no env file found — relying on injected env / defaults\n");
    return null;
  }
  let filled = 0;
  try {
    const parsed = parseEnvFile(readFileSync(path, "utf-8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
        filled += 1;
      }
    }
  } catch (err) {
    process.stderr.write(
      `escort: failed to read env file ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
  process.stderr.write(`escort: loaded ${filled} var(s) from ${path}\n`);
  return path;
}
