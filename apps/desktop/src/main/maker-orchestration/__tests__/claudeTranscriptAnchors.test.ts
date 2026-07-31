import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findClaudeSessionJsonl,
  resetClaudeTranscriptPathCacheForTesting,
} from '../claudeTranscriptAnchors';

const roots: string[] = [];

afterEach(async () => {
  resetClaudeTranscriptPathCacheForTesting();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-transcript-anchor-'));
  roots.push(root);
  return root;
}

async function writeTranscript(root: string, project: string, sessionId: string): Promise<string> {
  const dir = path.join(root, project);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, '{"uuid":"u1","type":"assistant"}\n');
  return file;
}

describe('Claude transcript path lookup cache', () => {
  it('uses a negative cache and retries after the miss TTL', async () => {
    const root = await createRoot();
    let now = 1_000;

    await expect(findClaudeSessionJsonl('s1', undefined, root, () => now)).resolves.toBeNull();
    const file = await writeTranscript(root, 'project-a', 's1');
    await expect(findClaudeSessionJsonl('s1', undefined, root, () => now)).resolves.toBeNull();

    now += 5_001;
    await expect(findClaudeSessionJsonl('s1', undefined, root, () => now)).resolves.toBe(file);
  });

  it('invalidates a cached hit when the file disappears', async () => {
    const root = await createRoot();
    const file = await writeTranscript(root, 'project-a', 's1');
    let now = 1_000;

    await expect(findClaudeSessionJsonl('s1', undefined, root, () => now)).resolves.toBe(file);
    await unlink(file);
    const replacement = await writeTranscript(root, 'nested/project-b', 's1');
    now += 1;

    await expect(findClaudeSessionJsonl('s1', undefined, root, () => now)).resolves.toBe(replacement);
  });

  it('keeps config roots isolated', async () => {
    const firstRoot = await createRoot();
    const secondRoot = await createRoot();
    const first = await writeTranscript(firstRoot, 'project-a', 's1');
    const second = await writeTranscript(secondRoot, 'project-b', 's1');

    await expect(findClaudeSessionJsonl('s1', undefined, firstRoot)).resolves.toBe(first);
    await expect(findClaudeSessionJsonl('s1', undefined, secondRoot)).resolves.toBe(second);
  });

  it('prefers the direct working-directory project path', async () => {
    const root = await createRoot();
    const workingDir = path.join(root, 'workspace');
    await mkdir(workingDir, { recursive: true });
    await writeTranscript(root, 'fallback', 's1');
    const directProject = workingDir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
    const direct = await writeTranscript(root, directProject, 's1');

    await expect(findClaudeSessionJsonl('s1', workingDir, root)).resolves.toBe(direct);
  });
});
