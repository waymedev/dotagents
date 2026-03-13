import fs from 'fs';
import path from 'path';
import { test, expect } from 'bun:test';
import { loadCustomMappings, loadCustomMappingEntries, validateEntry } from '../src/core/custom-mappings.js';
import { resolveRoots } from '../src/core/paths.js';
import { buildLinkPlan } from '../src/core/plan.js';
import { applyLinkPlan } from '../src/core/apply.js';
import { createBackupSession, finalizeBackup } from '../src/core/backup.js';
import { makeTempDir, writeFile } from './helpers.js';

async function readLinkTarget(target: string): Promise<string> {
  const link = await fs.promises.readlink(target);
  return path.isAbsolute(link) ? link : path.resolve(path.dirname(target), link);
}

// --- validateEntry ---

test('validateEntry: rejects non-object', () => {
  expect(validateEntry(null, 0)).toBeNull();
  expect(validateEntry('string', 0)).toBeNull();
  expect(validateEntry(42, 0)).toBeNull();
});

test('validateEntry: rejects missing or empty name', () => {
  expect(validateEntry({ source: 'rules', kind: 'dir', targets: [] }, 0)).toBeNull();
  expect(validateEntry({ name: '', source: 'rules', kind: 'dir', targets: [] }, 0)).toBeNull();
});

test('validateEntry: rejects absolute source', () => {
  expect(validateEntry({ name: 'x', source: '/etc/rules', kind: 'dir', targets: [] }, 0)).toBeNull();
});

test('validateEntry: rejects source with ..', () => {
  expect(validateEntry({ name: 'x', source: '../escape', kind: 'dir', targets: [] }, 0)).toBeNull();
});

test('validateEntry: rejects invalid kind', () => {
  expect(validateEntry({ name: 'x', source: 'rules', kind: 'symlink', targets: [] }, 0)).toBeNull();
});

test('validateEntry: rejects non-array targets', () => {
  expect(validateEntry({ name: 'x', source: 'rules', kind: 'dir', targets: { claude: 'a' } }, 0)).toBeNull();
});

test('validateEntry: rejects target with ..', () => {
  const entry = validateEntry({ name: 'x', source: 'rules', kind: 'dir', targets: ['../escape'] }, 0);
  expect(entry).not.toBeNull();
  expect(entry!.targets).toHaveLength(0);
});

test('validateEntry: accepts valid entry with string[] targets', () => {
  const entry = validateEntry({
    name: 'my-rules',
    source: 'rules',
    kind: 'dir',
    targets: ['/abs/path', 'relative/path'],
  }, 0);
  expect(entry).not.toBeNull();
  expect(entry!.name).toBe('my-rules');
  expect(entry!.kind).toBe('dir');
  expect(entry!.targets).toEqual(['/abs/path', 'relative/path']);
});

// --- loadCustomMappingEntries ---

test('loadCustomMappingEntries: no config returns empty', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const entries = await loadCustomMappingEntries(canonical);
  expect(entries).toEqual([]);
});

test('loadCustomMappingEntries: returns validated entries', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [
      { name: 'a', source: 'src-a', kind: 'dir', targets: ['/target/a'] },
      { name: '', source: 'bad', kind: 'dir', targets: [] },
      { name: 'b', source: 'src-b', kind: 'file', targets: ['rel/b'] },
    ],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const entries = await loadCustomMappingEntries(canonical);
  expect(entries).toHaveLength(2);
  expect(entries[0].name).toBe('a');
  expect(entries[1].name).toBe('b');
});

// --- loadCustomMappings ---

test('no config file returns empty array', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const result = await loadCustomMappings(canonical, home);
  expect(result).toEqual([]);
});

test('invalid JSON returns empty array', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  await writeFile(path.join(canonical, 'mappings.json'), 'not json{{{');
  const result = await loadCustomMappings(canonical, home);
  expect(result).toEqual([]);
});

test('missing mappings array returns empty', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify({ other: true }));
  const result = await loadCustomMappings(canonical, home);
  expect(result).toEqual([]);
});

test('absolute target paths are used directly', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [{
      name: 'my-rules',
      source: 'rules',
      kind: 'dir',
      targets: ['/absolute/target/path'],
    }],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const result = await loadCustomMappings(canonical, home);

  expect(result).toHaveLength(1);
  expect(result[0].name).toBe('custom:my-rules');
  expect(result[0].source).toBe(path.join(canonical, 'rules'));
  expect(result[0].targets).toEqual(['/absolute/target/path']);
});

test('relative target paths resolve against baseDir', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [{
      name: 'my-rules',
      source: 'rules',
      kind: 'dir',
      targets: ['relative/target'],
    }],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const result = await loadCustomMappings(canonical, home);

  expect(result).toHaveLength(1);
  expect(result[0].targets).toEqual([path.resolve(home, 'relative/target')]);
});

test('mixed absolute and relative targets', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [{
      name: 'mixed',
      source: 'src',
      kind: 'dir',
      targets: ['/abs/path', 'rel/path'],
    }],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const result = await loadCustomMappings(canonical, home);

  expect(result).toHaveLength(1);
  expect(result[0].targets).toEqual(['/abs/path', path.resolve(home, 'rel/path')]);
});

test('selectedNames filters entries', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [
      { name: 'keep', source: 'a', kind: 'dir', targets: ['/target/a'] },
      { name: 'skip', source: 'b', kind: 'dir', targets: ['/target/b'] },
    ],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const result = await loadCustomMappings(canonical, home, { selectedNames: ['keep'] });

  expect(result).toHaveLength(1);
  expect(result[0].name).toBe('custom:keep');
});

test('selectedNames empty array returns nothing', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [
      { name: 'a', source: 'x', kind: 'dir', targets: ['/target/x'] },
    ],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const result = await loadCustomMappings(canonical, home, { selectedNames: [] });
  expect(result).toEqual([]);
});

test('no selectedNames returns all entries', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [
      { name: 'a', source: 'x', kind: 'dir', targets: ['/t/a'] },
      { name: 'b', source: 'y', kind: 'dir', targets: ['/t/b'] },
    ],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const result = await loadCustomMappings(canonical, home);
  expect(result).toHaveLength(2);
});

test('invalid entries are skipped, valid ones kept', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [
      { name: '', source: 'bad', kind: 'dir', targets: ['/x'] },
      { name: 'good', source: 'rules', kind: 'dir', targets: ['/target/rules'] },
      { name: 'abs', source: '/etc/bad', kind: 'dir', targets: ['/x'] },
    ],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const result = await loadCustomMappings(canonical, home);

  expect(result).toHaveLength(1);
  expect(result[0].name).toBe('custom:good');
});

test('duplicate names are skipped', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const config = {
    mappings: [
      { name: 'dup', source: 'first', kind: 'dir', targets: ['/a'] },
      { name: 'dup', source: 'second', kind: 'dir', targets: ['/b'] },
    ],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  const result = await loadCustomMappings(canonical, home);

  expect(result).toHaveLength(1);
  expect(result[0].source).toBe(path.join(canonical, 'first'));
});

// --- Integration: full plan + apply ---

test('custom mapping creates symlinks via buildLinkPlan + applyLinkPlan', async () => {
  const home = await makeTempDir('dotagents-custom-');
  const canonical = path.join(home, '.agents');
  const targetDir = path.join(home, 'custom-target');

  const config = {
    mappings: [{
      name: 'my-rules',
      source: 'rules',
      kind: 'dir',
      targets: [targetDir],
    }],
  };
  await writeFile(path.join(canonical, 'mappings.json'), JSON.stringify(config));
  await fs.promises.mkdir(path.join(canonical, 'rules'), { recursive: true });
  await writeFile(path.join(canonical, 'rules', 'test.md'), '# test rule');

  const plan = await buildLinkPlan({ scope: 'global', homeDir: home, customMappings: ['my-rules'] });
  const backup = await createBackupSession({
    canonicalRoot: canonical,
    scope: 'global',
    operation: 'test',
  });
  const result = await applyLinkPlan(plan, { backup });
  await finalizeBackup(backup);
  expect(result.applied).toBeGreaterThan(0);

  expect(await readLinkTarget(targetDir)).toBe(path.join(canonical, 'rules'));

  const content = await fs.promises.readFile(path.join(targetDir, 'test.md'), 'utf8');
  expect(content).toBe('# test rule');
});
