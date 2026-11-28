/**
 * MCP client configuration: where each client keeps its server list, how to
 * tell whether it is installed, and how to add or remove our entry safely.
 *
 * Config locations cross-checked against jacob-bd/gemini-notebook-mcp-cli
 * `cli/commands/setup.py` and each client's own documentation. Two clients
 * (Claude Code, Codex) own a CLI that edits their config; we call it rather
 * than rewrite a file the running client also writes.
 *
 * Every write is: refuse a symbolic link, back the file up next to itself,
 * write a temporary sibling, rename it over the original. A file that does not
 * parse is never rewritten — the user gets the snippet to paste instead.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export const SERVER_NAME = 'notebooklm';
export const PACKAGE_SPEC = '@roomi-fields/notebooklm-mcp@latest';
export const SERVER_COMMAND = 'npx';
export const SERVER_ARGS = ['-y', PACKAGE_SPEC];

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  appData?: string;
  xdgConfigHome?: string;
  /** Whether an executable is on PATH. Injected so tests never spawn. */
  hasCommand: (name: string) => boolean;
  /** Run a client CLI; returns its exit status. Injected for the same reason. */
  run: (cmd: string, args: string[]) => { status: number | null; output: string };
}

export type ClientStatus = 'configured' | 'not-configured' | 'outdated' | 'unreadable';

export interface ClientReport {
  id: string;
  name: string;
  status: ClientStatus;
  /** The config file, or the CLI that manages it. */
  location: string;
  detail?: string;
}

export interface Client {
  id: string;
  name: string;
  /** Installed on this machine (its config or its CLI exists). */
  detect(env: SetupEnv): boolean;
  inspect(env: SetupEnv): ClientReport;
  /**
   * Add our entry. An existing `notebooklm` entry that differs from ours (a
   * clone run with `node dist/index.js`, a pinned version…) is the user's own
   * choice and is kept unless `force`. Returns a one-line description.
   */
  install(env: SetupEnv, opts?: { force?: boolean }): string;
  remove(env: SetupEnv): string;
  /** What to paste by hand when the file cannot be edited automatically. */
  manual(env: SetupEnv): string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function vscodeUserDir(env: SetupEnv): string {
  if (env.platform === 'darwin') {
    return path.join(env.home, 'Library', 'Application Support', 'Code', 'User');
  }
  if (env.platform === 'win32') return path.join(env.appData ?? env.home, 'Code', 'User');
  return path.join(env.xdgConfigHome ?? path.join(env.home, '.config'), 'Code', 'User');
}

function claudeDesktopConfig(env: SetupEnv): string {
  if (env.platform === 'darwin') {
    return path.join(
      env.home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }
  if (env.platform === 'win32') {
    return path.join(env.appData ?? env.home, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(
    env.xdgConfigHome ?? path.join(env.home, '.config'),
    'Claude',
    'claude_desktop_config.json'
  );
}

// ---------------------------------------------------------------------------
// Safe JSON editing
// ---------------------------------------------------------------------------

export class UnreadableConfigError extends Error {
  constructor(
    readonly file: string,
    reason: string
  ) {
    super(`${file} could not be read as JSON (${reason}); it was left untouched`);
    this.name = 'UnreadableConfigError';
  }
}

export function readJsonObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf-8');
  if (!raw.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new UnreadableConfigError(file, e instanceof Error ? e.message : String(e));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnreadableConfigError(file, 'not a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Back up then atomically replace `file`. Returns the backup path, if any. */
export function writeJsonSafely(
  file: string,
  value: Record<string, unknown>,
  now = new Date()
): string | null {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`Refusing to write through a symbolic link: ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  return backup;
}

function entryMatches(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { command?: unknown; args?: unknown };
  return (
    e.command === SERVER_COMMAND &&
    Array.isArray(e.args) &&
    e.args.length === SERVER_ARGS.length &&
    e.args.every((a, i) => a === SERVER_ARGS[i])
  );
}

/**
 * A client whose config is one JSON file holding a map of servers under `key`.
 * `entry` builds our server object in that client's dialect.
 */
function jsonClient(spec: {
  id: string;
  name: string;
  file: (env: SetupEnv) => string;
  /** Directory whose presence means the client is installed. */
  marker: (env: SetupEnv) => string;
  key: string;
  entry: () => Record<string, unknown>;
}): Client {
  const servers = (config: Record<string, unknown>): Record<string, unknown> => {
    const v = config[spec.key];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  return {
    id: spec.id,
    name: spec.name,
    detect: (env) => fs.existsSync(spec.file(env)) || fs.existsSync(spec.marker(env)),
    inspect(env) {
      const file = spec.file(env);
      try {
        const current = servers(readJsonObject(file))[SERVER_NAME];
        const status: ClientStatus =
          current === undefined
            ? 'not-configured'
            : entryMatches(current)
              ? 'configured'
              : 'outdated';
        return { id: spec.id, name: spec.name, status, location: file };
      } catch (e) {
        return {
          id: spec.id,
          name: spec.name,
          status: 'unreadable',
          location: file,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    },
    install(env, opts = {}) {
      const file = spec.file(env);
      const config = readJsonObject(file);
      const map = servers(config);
      if (entryMatches(map[SERVER_NAME])) return `already configured in ${file}`;
      if (map[SERVER_NAME] !== undefined && !opts.force) {
        return `kept your own "${SERVER_NAME}" entry in ${file} (--force replaces it)`;
      }
      config[spec.key] = { ...map, [SERVER_NAME]: spec.entry() };
      const backup = writeJsonSafely(file, config);
      return `added to ${file}` + (backup ? ` (backup: ${backup})` : '');
    },
    remove(env) {
      const file = spec.file(env);
      const config = readJsonObject(file);
      const map = servers(config);
      if (!(SERVER_NAME in map)) return `not present in ${file}`;
      const rest = { ...map };
      delete rest[SERVER_NAME];
      config[spec.key] = rest;
      const backup = writeJsonSafely(file, config);
      return `removed from ${file}` + (backup ? ` (backup: ${backup})` : '');
    },
    manual(env) {
      return (
        `Add this to ${spec.file(env)}:\n` +
        JSON.stringify({ [spec.key]: { [SERVER_NAME]: spec.entry() } }, null, 2)
      );
    },
  };
}

const stdioEntry = () => ({ command: SERVER_COMMAND, args: [...SERVER_ARGS] });

/** A client that ships its own `mcp add/remove` CLI. */
function cliClient(spec: {
  id: string;
  name: string;
  bin: string;
  addArgs: string[];
  removeArgs: string[];
  /** Whether our server is registered, read without spawning when possible. */
  isConfigured: (env: SetupEnv) => boolean;
  /**
   * Something other than the client's server list already provides our
   * server (a plugin); adding it again would start it twice. Returns what.
   */
  providedBy?: (env: SetupEnv) => string | null;
}): Client {
  const manualLine = `${spec.bin} ${spec.addArgs.join(' ')}`;
  return {
    id: spec.id,
    name: spec.name,
    detect: (env) => env.hasCommand(spec.bin),
    inspect(env) {
      const provider = spec.providedBy?.(env);
      if (provider) {
        return {
          id: spec.id,
          name: spec.name,
          status: 'configured',
          location: provider,
        };
      }
      return {
        id: spec.id,
        name: spec.name,
        status: spec.isConfigured(env) ? 'configured' : 'not-configured',
        location: `${spec.bin} CLI`,
      };
    },
    install(env) {
      const provider = spec.providedBy?.(env);
      if (provider) return `already provided by ${provider}`;
      if (spec.isConfigured(env)) return `already configured (${spec.bin} mcp)`;
      const r = env.run(spec.bin, spec.addArgs);
      if (r.status !== 0) throw new Error(`${manualLine} failed: ${r.output.trim()}`);
      return `added with: ${manualLine}`;
    },
    remove(env) {
      const provider = spec.providedBy?.(env);
      if (provider && !spec.isConfigured(env)) {
        return `provided by ${provider}: uninstall it from inside the client`;
      }
      if (!spec.isConfigured(env)) return `not present (${spec.bin} mcp)`;
      const r = env.run(spec.bin, spec.removeArgs);
      if (r.status !== 0) {
        throw new Error(`${spec.bin} ${spec.removeArgs.join(' ')} failed: ${r.output.trim()}`);
      }
      return `removed with: ${spec.bin} ${spec.removeArgs.join(' ')}`;
    },
    manual: () => `Run: ${manualLine}`,
  };
}

/**
 * The Claude Code plugin (`notebooklm@roomi-fields`) ships this server, and
 * `claude mcp get` does not list plugin servers — verified on 2026-11-28.
 */
function claudePluginProvider(env: SetupEnv): string | null {
  const file = path.join(env.home, '.claude', 'plugins', 'installed_plugins.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      plugins?: Record<string, unknown>;
    };
    const key = Object.keys(data.plugins ?? {}).find((k) => k.startsWith('notebooklm@'));
    return key ? `the Claude Code plugin ${key}` : null;
  } catch {
    return null;
  }
}

function codexConfigured(env: SetupEnv): boolean {
  const file = path.join(env.home, '.codex', 'config.toml');
  if (!fs.existsSync(file)) return false;
  return new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(
    fs.readFileSync(file, 'utf-8')
  );
}

export const CLIENTS: Client[] = [
  cliClient({
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    addArgs: ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', SERVER_COMMAND, ...SERVER_ARGS],
    removeArgs: ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
    isConfigured: (env) => env.run('claude', ['mcp', 'get', SERVER_NAME]).status === 0,
    providedBy: claudePluginProvider,
  }),
  cliClient({
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    addArgs: ['mcp', 'add', SERVER_NAME, '--', SERVER_COMMAND, ...SERVER_ARGS],
    removeArgs: ['mcp', 'remove', SERVER_NAME],
    isConfigured: codexConfigured,
  }),
  jsonClient({
    id: 'claude-desktop',
    name: 'Claude Desktop',
    file: claudeDesktopConfig,
    marker: (env) => path.dirname(claudeDesktopConfig(env)),
    key: 'mcpServers',
    entry: stdioEntry,
  }),
  jsonClient({
    id: 'cursor',
    name: 'Cursor',
    file: (env) => path.join(env.home, '.cursor', 'mcp.json'),
    marker: (env) => path.join(env.home, '.cursor'),
    key: 'mcpServers',
    entry: stdioEntry,
  }),
  jsonClient({
    id: 'windsurf',
    name: 'Windsurf',
    file: (env) => path.join(env.home, '.codeium', 'windsurf', 'mcp_config.json'),
    marker: (env) => path.join(env.home, '.codeium', 'windsurf'),
    key: 'mcpServers',
    entry: stdioEntry,
  }),
  jsonClient({
    id: 'gemini-cli',
    name: 'Gemini CLI',
    file: (env) => path.join(env.home, '.gemini', 'settings.json'),
    marker: (env) => path.join(env.home, '.gemini'),
    key: 'mcpServers',
    entry: stdioEntry,
  }),
  jsonClient({
    id: 'vscode',
    name: 'VS Code (Copilot)',
    file: (env) => path.join(vscodeUserDir(env), 'mcp.json'),
    marker: (env) => vscodeUserDir(env),
    key: 'servers',
    entry: () => ({ type: 'stdio', ...stdioEntry() }),
  }),
  jsonClient({
    id: 'cline',
    name: 'Cline (VS Code)',
    file: (env) =>
      path.join(
        vscodeUserDir(env),
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json'
      ),
    marker: (env) => path.join(vscodeUserDir(env), 'globalStorage', 'saoudrizwan.claude-dev'),
    key: 'mcpServers',
    entry: stdioEntry,
  }),
];

export function realEnv(): SetupEnv {
  const isWin = process.platform === 'win32';
  return {
    home: process.env.HOME || process.env.USERPROFILE || '',
    platform: process.platform,
    appData: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    hasCommand(name) {
      const r = spawnSync(isWin ? 'where' : 'which', [name], { stdio: 'ignore' });
      return r.status === 0;
    },
    run(cmd, args) {
      const r = spawnSync(cmd, args, { encoding: 'utf-8', shell: isWin, timeout: 30000 });
      return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
  };
}
