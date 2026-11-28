/**
 * `notebooklm-mcp setup` — register this server with the MCP clients installed
 * on this machine, instead of asking the user to edit each client's config by
 * hand. That hand edit is where most visitors stopped (ROADMAP, Onboarding).
 *
 *   notebooklm-mcp setup                 detect clients, confirm, configure
 *   notebooklm-mcp setup --list          show what is detected, change nothing
 *   notebooklm-mcp setup --dry-run       show what would change
 *   notebooklm-mcp setup --client cursor,claude-desktop
 *   notebooklm-mcp setup --yes           no confirmation (non-interactive use)
 *   notebooklm-mcp setup --force         replace a differing "notebooklm" entry
 *   notebooklm-mcp setup --remove        take our entry out again
 */

import {
  CLIENTS,
  UnreadableConfigError,
  type Client,
  type ClientReport,
  type SetupEnv,
} from './setup-clients.js';

export interface SetupOptions {
  list: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  remove: boolean;
  clients: string[] | null;
  help: boolean;
}

export function parseSetupArgs(argv: string[]): SetupOptions {
  const o: SetupOptions = {
    list: false,
    dryRun: false,
    yes: false,
    force: false,
    remove: false,
    clients: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') o.list = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--force') o.force = true;
    else if (a === '--remove') o.remove = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--client' || a.startsWith('--client=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!v) throw new Error('--client needs a value, e.g. --client cursor,claude-desktop');
      o.clients = [
        ...(o.clients ?? []),
        ...v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ];
    } else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

const STATUS_LABEL: Record<ClientReport['status'], string> = {
  configured: 'configured',
  'not-configured': 'not configured',
  outdated: 'has a different "notebooklm" entry',
  unreadable: 'config unreadable — left untouched',
};

const USAGE = `Usage: notebooklm-mcp setup [options]

Registers the NotebookLM MCP server with the MCP clients found on this machine.
Each config file is backed up next to itself before it is changed.

Options:
  --list              Show detected clients and their status; change nothing
  --dry-run           Show what would change; change nothing
  --client <ids>      Only these clients (comma-separated): ${CLIENTS.map((c) => c.id).join(', ')}
  --yes, -y           Do not ask for confirmation
  --force             Replace an existing "notebooklm" entry that differs from ours
  --remove            Remove our entry instead of adding it
  --help, -h          Show this help`;

export async function runSetup(
  argv: string[],
  env: SetupEnv,
  io: {
    out: (line: string) => void;
    confirm: (question: string) => Promise<boolean>;
    interactive: boolean;
  }
): Promise<number> {
  let opts: SetupOptions;
  try {
    opts = parseSetupArgs(argv);
  } catch (e) {
    io.out(e instanceof Error ? e.message : String(e));
    io.out(USAGE);
    return 2;
  }
  if (opts.help) {
    io.out(USAGE);
    return 0;
  }

  if (opts.clients) {
    const unknown = opts.clients.filter((id) => !CLIENTS.some((c) => c.id === id));
    if (unknown.length) {
      io.out(
        `Unknown client: ${unknown.join(', ')}. Known: ${CLIENTS.map((c) => c.id).join(', ')}`
      );
      return 2;
    }
  }
  const candidates: Client[] = opts.clients
    ? CLIENTS.filter((c) => opts.clients!.includes(c.id))
    : CLIENTS.filter((c) => c.detect(env));

  if (candidates.length === 0) {
    io.out('No supported MCP client was found on this machine.');
    io.out(`Supported: ${CLIENTS.map((c) => c.name).join(', ')}.`);
    io.out('Name one explicitly with --client <id>, or see the README for manual setup.');
    return 1;
  }

  const reports = candidates.map((c) => ({ client: c, report: c.inspect(env) }));
  io.out(opts.clients ? 'Selected MCP clients:' : 'Detected MCP clients:');
  for (const { report } of reports) {
    io.out(`  ${report.name.padEnd(20)} ${STATUS_LABEL[report.status]}  (${report.location})`);
  }
  if (opts.list) return 0;

  const todo = reports.filter(({ report }) => {
    if (report.status === 'unreadable') return false;
    if (opts.remove) return report.status !== 'not-configured';
    return report.status === 'not-configured' || (report.status === 'outdated' && opts.force);
  });
  for (const { client, report } of reports) {
    if (report.status === 'unreadable') {
      io.out(`\n${client.name}: ${report.detail}\n${client.manual(env)}`);
    } else if (report.status === 'outdated' && !opts.remove && !opts.force) {
      io.out(`\n${client.name}: kept your own "notebooklm" entry (--force replaces it).`);
    }
  }
  if (todo.length === 0) {
    io.out(
      opts.remove ? '\nNothing to remove.' : '\nNothing to do: every client is already set up.'
    );
    return reports.some((r) => r.report.status === 'unreadable') ? 1 : 0;
  }

  const verb = opts.remove ? 'Remove from' : 'Configure';
  const names = todo.map((t) => t.client.name).join(', ');
  if (opts.dryRun) {
    io.out(`\nDry run — would ${verb.toLowerCase()}: ${names}. Nothing was changed.`);
    return 0;
  }
  if (!opts.yes) {
    if (!io.interactive) {
      io.out(`\nWould ${verb.toLowerCase()}: ${names}. Re-run with --yes to apply.`);
      return 1;
    }
    if (!(await io.confirm(`\n${verb} ${names}? [Y/n] `))) {
      io.out('Cancelled. Nothing was changed.');
      return 1;
    }
  }

  let failed = 0;
  for (const { client } of todo) {
    try {
      const what = opts.remove ? client.remove(env) : client.install(env, { force: opts.force });
      io.out(`  ✓ ${client.name}: ${what}`);
    } catch (e) {
      failed++;
      const reason = e instanceof Error ? e.message : String(e);
      io.out(`  ✗ ${client.name}: ${reason}`);
      if (!(e instanceof UnreadableConfigError)) io.out(`    ${client.manual(env)}`);
    }
  }

  if (!opts.remove && failed < todo.length) {
    io.out('\nNext: log in to Google once, in this terminal (a Chrome window opens):');
    io.out('  npx -y -p @roomi-fields/notebooklm-mcp notebooklm-mcp-setup-auth');
    io.out('Then restart your MCP client so it picks the server up.');
  }
  return failed ? 1 : 0;
}
