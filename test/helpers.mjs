import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export async function createRepo(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'repoproof-tests-'));
  const target = (name) => {
    const path = resolve(dir, name);
    const rel = relative(dir, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Invalid fixture path.');
    return path;
  };
  const git = (args, options = {}) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', windowsHide: true, ...options, cwd: dir, shell: false,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env },
  });
  const write = async (name, text) => {
    const path = target(name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  };
  const remove = async (name) => rm(target(name), { force: true });
  git(['init', '-q']);
  git(['config', 'user.name', 'RepoProof Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.excludesFile', join(dir, '.git', 'info', 'exclude')]);
  for (const [name, text] of Object.entries(files)) await write(name, text);
  return { dir, git, write, remove };
}
