import path from 'path';
import type { Mapping, SourceKind } from './types.js';
import { readText } from '../utils/fs.js';

export type CustomMappingEntry = {
  name: string;
  source: string;
  kind: SourceKind;
  targets: string[];
};

export type CustomMappingsConfig = {
  mappings: CustomMappingEntry[];
};

const VALID_KINDS = new Set<string>(['file', 'dir']);

export function validateEntry(
  entry: unknown,
  index: number,
): CustomMappingEntry | null {
  if (typeof entry !== 'object' || entry === null) {
    console.warn(`[custom-mappings] entry ${index}: not an object, skipping`);
    return null;
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.name !== 'string' || e.name.trim() === '') {
    console.warn(`[custom-mappings] entry ${index}: missing or empty name, skipping`);
    return null;
  }
  if (typeof e.source !== 'string' || e.source.trim() === '') {
    console.warn(`[custom-mappings] entry ${index} (${e.name}): missing or empty source, skipping`);
    return null;
  }
  if (path.isAbsolute(e.source)) {
    console.warn(`[custom-mappings] entry ${index} (${e.name}): source must be relative, skipping`);
    return null;
  }
  if (e.source.includes('..')) {
    console.warn(`[custom-mappings] entry ${index} (${e.name}): source must not contain "..", skipping`);
    return null;
  }
  if (typeof e.kind !== 'string' || !VALID_KINDS.has(e.kind)) {
    console.warn(`[custom-mappings] entry ${index} (${e.name}): invalid kind "${e.kind}", skipping`);
    return null;
  }
  if (!Array.isArray(e.targets)) {
    console.warn(`[custom-mappings] entry ${index} (${e.name}): targets must be an array, skipping`);
    return null;
  }
  const validTargets: string[] = [];
  for (const t of e.targets) {
    if (typeof t !== 'string' || t.trim() === '') {
      console.warn(`[custom-mappings] entry ${index} (${e.name}): invalid target value, skipping target`);
      continue;
    }
    if (t.includes('..')) {
      console.warn(`[custom-mappings] entry ${index} (${e.name}): target must not contain "..", skipping target`);
      continue;
    }
    validTargets.push(t);
  }

  return {
    name: e.name.trim(),
    source: e.source,
    kind: e.kind as SourceKind,
    targets: validTargets,
  };
}

async function readConfig(canonicalRoot: string): Promise<CustomMappingEntry[]> {
  const configPath = path.join(canonicalRoot, 'mappings.json');
  let raw: string;
  try {
    raw = await readText(configPath);
  } catch {
    return [];
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    console.warn(`[custom-mappings] failed to parse ${configPath}, skipping`);
    return [];
  }

  if (typeof config !== 'object' || config === null) return [];
  const c = config as Record<string, unknown>;
  if (!Array.isArray(c.mappings)) return [];

  const seenNames = new Set<string>();
  const entries: CustomMappingEntry[] = [];

  for (let i = 0; i < c.mappings.length; i++) {
    const entry = validateEntry(c.mappings[i], i);
    if (!entry) continue;
    if (seenNames.has(entry.name)) {
      console.warn(`[custom-mappings] duplicate name "${entry.name}", skipping`);
      continue;
    }
    seenNames.add(entry.name);
    entries.push(entry);
  }

  return entries;
}

/**
 * Load and validate custom mapping entries from .agents/mappings.json.
 * Returns raw entries (for TUI display / selection).
 */
export async function loadCustomMappingEntries(
  canonicalRoot: string,
): Promise<CustomMappingEntry[]> {
  return readConfig(canonicalRoot);
}

export type LoadCustomMappingsOptions = {
  selectedNames?: string[];
};

/**
 * Load custom mappings and resolve targets to absolute paths.
 * @param canonicalRoot - path to .agents directory
 * @param baseDir - base for resolving relative targets (homeDir for global, projectRoot for project)
 * @param opts - optional filtering
 */
export async function loadCustomMappings(
  canonicalRoot: string,
  baseDir: string,
  opts?: LoadCustomMappingsOptions,
): Promise<Mapping[]> {
  const entries = await readConfig(canonicalRoot);
  const selectedSet = opts?.selectedNames
    ? new Set(opts.selectedNames)
    : null;

  const mappings: Mapping[] = [];

  for (const entry of entries) {
    if (selectedSet && !selectedSet.has(entry.name)) continue;

    const source = path.join(canonicalRoot, entry.source);
    const resolvedTargets: string[] = [];
    for (const t of entry.targets) {
      resolvedTargets.push(
        path.isAbsolute(t) ? t : path.resolve(baseDir, t),
      );
    }

    if (resolvedTargets.length === 0) continue;

    mappings.push({
      name: `custom:${entry.name}`,
      source,
      targets: resolvedTargets,
      kind: entry.kind,
    });
  }

  return mappings;
}
