import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite, createProfile, profilePath, teamOf } from './profiles.ts';
const exec = promisify(execFile);

const IDENTITY = ['-c', 'user.name=OptChat', '-c', 'user.email=optchat@localhost', '-c', 'commit.gpgsign=false'];
const run = (cwd: string, args: string[], timeout?: number) => exec('git', ['-C', cwd, ...IDENTITY, ...args], { maxBuffer: 1_000_000, timeout });

export async function checkpoint(directory: string, onOffline?: (reason: string) => void): Promise<void> {
  const team = teamOf(directory);
  if (team) return sync(team, onOffline);
  if (!existsSync(join(directory, '.git'))) {
    await run(directory, ['init', '-q', '-b', 'main']);
    atomicWrite(join(directory, '.gitignore'), '/runs/\n/memory.html\n/usage.jsonl\n*.tmp\n');
  }
  await run(directory, ['add', '-A', '--', '.']);
  const status = await run(directory, ['diff', '--cached', '--name-only']);
  if (!status.stdout.trim()) return;
  await run(directory, ['commit', '-q', '-m', 'Save OptChat memory']);
}

/** Local commit always succeeds or throws; only the network steps can go offline. */
async function sync({ root, me }: { root: string; me: string }, onOffline?: (reason: string) => void) {
  await run(root, ['add', '-A', '--', me]);
  if ((await run(root, ['diff', '--cached', '--name-only'])).stdout.trim()) await run(root, ['commit', '-q', '-m', `${me}: memory`]);
  try { await run(root, ['pull', '--rebase', '-q'], 20_000); await run(root, ['push', '-q'], 20_000); }
  catch (error) {
    await run(root, ['rebase', '--abort']).catch(() => {});
    onOffline?.(error instanceof Error ? error.message : String(error));
  }
}

export async function joinTeam(url: string, handle: string, warn: (s: string) => void): Promise<{ name: string; root: string }> {
  const team = url.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '').toLowerCase();
  const name = `${team}/${handle}`;
  const dir = profilePath(name); // validates both segments
  const root = dirname(dir);
  if (existsSync(root)) throw new Error(`Team already joined: ${team}`);
  if (/github\.com[/:]/.test(url)) {
    let visible: string | undefined;
    try { visible = (await exec('gh', ['repo', 'view', url, '--json', 'isPrivate'], { timeout: 15_000 })).stdout; }
    catch { warn('Could not verify the repo is private (gh unavailable). Continuing.'); }
    if (visible !== undefined && JSON.parse(visible).isPrivate === false) throw new Error('Team repo must be private.');
  }
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  await exec('git', ['clone', '-q', url, root], { maxBuffer: 1_000_000, timeout: 60_000 });
  if (existsSync(dir)) throw new Error(`Handle taken: ${handle}`);
  if (!existsSync(join(root, 'package.json'))) {
    atomicWrite(join(root, '.gitignore'), '*/runs/\n*/memory.html\n*/usage.jsonl\n*/pending-*.json\n*/imports/\n*.tmp\n');
    atomicWrite(join(root, 'AGENTS.md'), `# ${team}\n\nTeam instructions. Each member's agent reads this after their own AGENTS.md.\n`);
    atomicWrite(join(root, 'package.json'), JSON.stringify({ name: team, private: true, pi: { skills: ['./skills'], prompts: ['./prompts'] } }, null, 2) + '\n');
    atomicWrite(join(root, 'skills', '.gitkeep'), '');
    atomicWrite(join(root, 'prompts', '.gitkeep'), '');
    await run(root, ['add', '-A']);
    await run(root, ['commit', '-q', '-m', 'Initialize team']);
    await run(root, ['push', '-q', '-u', 'origin', 'HEAD'], 20_000);
  }
  await run(root, ['config', 'intrepidus.handle', handle]);
  createProfile(name);
  await checkpoint(dir, warn);
  return { name, root };
}
