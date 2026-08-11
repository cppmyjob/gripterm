import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeSettingsSource } from '../../domain/agents/claude-code/hook-policies';
import type { SettingsLocations } from '../../domain/agents/claude-code/settings-locations';

const JSON_SUFFIX = '.json';

export interface ClaudeSettingsRead {
  readonly sources: readonly ClaudeSettingsSource[];
  /** Files that exist and are not JSON. The CLI cannot read them either. */
  readonly unreadable: readonly string[];
}

/**
 * Reads whatever of the settings chain is actually on this machine.
 *
 * Absence is the ordinary case and says nothing: four of the five levels are
 * missing on a normal install, and a line about each would bury the one line
 * that matters. A file that EXISTS and is not JSON is the opposite -- the
 * person configured something that is not in force, and neither we nor the CLI
 * can see it -- so those are named.
 *
 * Nothing here throws. It runs during activation, beside the hook server, and a
 * report that can fail is a report that turns an explanation into an outage.
 */
export async function readClaudeSettings(
  locations: SettingsLocations
): Promise<ClaudeSettingsRead> {
  const files = [...locations.files, ...(await expand(locations.directories))];
  const sources: ClaudeSettingsSource[] = [];
  const unreadable: string[] = [];

  for (const path of files) {
    const raw = await readIfPresent(path);
    if (raw === null) {
      continue;
    }
    try {
      sources.push({ path, settings: JSON.parse(raw) });
    } catch {
      unreadable.push(path);
    }
  }

  return { sources, unreadable };
}

/**
 * The `*.json` of each drop-in directory, in name order.
 *
 * By name, because that is the only order a directory offers that a person can
 * predict -- and the numeric prefixes such directories are conventionally
 * filled with exist precisely to be read that way.
 */
async function expand(directories: readonly string[]): Promise<readonly string[]> {
  const found: string[] = [];

  for (const directory of directories) {
    try {
      const names = (await readdir(directory))
        .filter((name) => name.toLowerCase().endsWith(JSON_SUFFIX))
        .sort((left, right) => left.localeCompare(right));
      found.push(...names.map((name) => join(directory, name)));
    } catch {
      // Absent, or not a directory. Both mean there is nothing here to read.
    }
  }

  return found;
}

/** The contents, or `null` for anything that is not a readable file. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Missing, a directory, or unreadable by this user. None of the three is
    // something the person reading our log can act on.
    return null;
  }
}
