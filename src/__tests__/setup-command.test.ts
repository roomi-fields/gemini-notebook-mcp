/**
 * `notebooklm-mcp setup` against a throwaway home directory. Nothing here
 * spawns a process or touches the real user's configs: the environment
 * (home, PATH lookups, client CLIs) is injected.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runSetup } from '../cli/setup-command.js';
import { SERVER_ARGS, type SetupEnv } from '../cli/setup-clients.js';

let home: string;
let runs: string[][];
let lines: string[];

function env(overrides: Partial<SetupEnv> = {}): SetupEnv {
  return {
    home,
    platform: 'linux',
    xdgConfigHome: path.join(home, '.config'),
    hasCommand: () => false,
    run: (cmd, args) => {
      runs.push([cmd, ...args]);
      return { status: 1, output: '' };
    },
    ...overrides,
  };
}

const io = (interactive = false, answer = true) => ({
  out: (l: string) => lines.push(l),
  interactive,
  confirm: async () => answer,
});

const cursorFile = () => path.join(home, '.cursor', 'mcp.json');
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const ours = { command: 'npx', args: [...SERVER_ARGS] };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nblm-setup-'));
  runs = [];
  lines = [];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('notebooklm-mcp setup', () => {
  it('adds our server next to the existing ones and backs the file up', async () => {
    write(cursorFile(), { mcpServers: { other: { command: 'x' } } });
    expect(await runSetup(['--yes'], env(), io())).toBe(0);
    expect(read(cursorFile()).mcpServers).toEqual({ other: { command: 'x' }, notebooklm: ours });
    const backups = fs.readdirSync(path.dirname(cursorFile())).filter((f) => f.includes('.bak-'));
    expect(backups).toHaveLength(1);
    expect(lines.join('\n')).toContain('notebooklm-mcp-setup-auth');
  });

  it('creates a config for a client that is installed but has none yet', async () => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    expect(await runSetup(['--yes'], env(), io())).toBe(0);
    expect(read(path.join(home, '.gemini', 'settings.json'))).toEqual({
      mcpServers: { notebooklm: ours },
    });
  });

  it('writes the VS Code dialect: a "servers" map with an explicit stdio type', async () => {
    fs.mkdirSync(path.join(home, '.config', 'Code', 'User'), { recursive: true });
    await runSetup(['--yes', '--client', 'vscode'], env(), io());
    expect(read(path.join(home, '.config', 'Code', 'User', 'mcp.json'))).toEqual({
      servers: { notebooklm: { type: 'stdio', ...ours } },
    });
  });

  it('never rewrites a file it cannot parse, and prints the snippet instead', async () => {
    write(cursorFile(), '{ "mcpServers": { // a comment\n } }');
    const before = fs.readFileSync(cursorFile(), 'utf-8');
    expect(await runSetup(['--yes'], env(), io())).toBe(1);
    expect(fs.readFileSync(cursorFile(), 'utf-8')).toBe(before);
    expect(lines.join('\n')).toContain('"notebooklm"');
  });

  it("keeps the user's own notebooklm entry unless --force", async () => {
    const custom = { command: 'node', args: ['/src/notebooklm-mcp/dist/index.js'] };
    write(cursorFile(), { mcpServers: { notebooklm: custom } });
    await runSetup(['--yes'], env(), io());
    expect(read(cursorFile()).mcpServers.notebooklm).toEqual(custom);
    await runSetup(['--yes', '--force'], env(), io());
    expect(read(cursorFile()).mcpServers.notebooklm).toEqual(ours);
  });

  it('--remove takes out only our entry', async () => {
    write(cursorFile(), { mcpServers: { other: { command: 'x' }, notebooklm: ours } });
    await runSetup(['--yes', '--remove'], env(), io());
    expect(read(cursorFile()).mcpServers).toEqual({ other: { command: 'x' } });
  });

  it('changes nothing on --dry-run, --list, or without --yes when not interactive', async () => {
    write(cursorFile(), { mcpServers: {} });
    for (const argv of [['--dry-run'], ['--list'], []]) {
      await runSetup(argv, env(), io(false));
      expect(read(cursorFile())).toEqual({ mcpServers: {} });
    }
    expect(lines.join('\n')).toContain('--yes');
  });

  it('asks before changing anything in a terminal, and honours a no', async () => {
    write(cursorFile(), { mcpServers: {} });
    expect(await runSetup([], env(), io(true, false))).toBe(1);
    expect(read(cursorFile())).toEqual({ mcpServers: {} });
  });

  it('refuses to write through a symbolic link', async () => {
    const real = path.join(home, 'elsewhere.json');
    write(real, { mcpServers: {} });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.symlinkSync(real, cursorFile());
    expect(await runSetup(['--yes'], env(), io())).toBe(1);
    expect(read(real)).toEqual({ mcpServers: {} });
  });

  it('uses the Claude Code CLI, and not when the plugin already provides the server', async () => {
    const withClaude = env({
      hasCommand: (n) => n === 'claude',
      run: (cmd, args) => {
        runs.push([cmd, ...args]);
        return { status: args[1] === 'get' ? 1 : 0, output: '' };
      },
    });
    await runSetup(['--yes'], withClaude, io());
    expect(runs).toContainEqual([
      'claude',
      'mcp',
      'add',
      '--scope',
      'user',
      'notebooklm',
      '--',
      'npx',
      ...SERVER_ARGS,
    ]);

    runs = [];
    write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      plugins: { 'notebooklm@roomi-fields': [] },
    });
    await runSetup(['--yes'], withClaude, io());
    expect(runs.filter((r) => r[2] === 'add')).toEqual([]);
  });

  it('reports no client rather than inventing one', async () => {
    expect(await runSetup(['--yes'], env(), io())).toBe(1);
    expect(lines[0]).toContain('No supported MCP client');
  });

  it('rejects an unknown client id', async () => {
    expect(await runSetup(['--client', 'notepad'], env(), io())).toBe(2);
  });
});
