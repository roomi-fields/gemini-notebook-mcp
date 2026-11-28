#!/usr/bin/env node
/**
 * Entry point of `notebooklm-mcp setup`; the logic lives in setup-command.ts.
 */

import readline from 'readline';
import { realEnv } from './setup-clients.js';
import { runSetup } from './setup-command.js';

async function main(): Promise<void> {
  const rl = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const code = await runSetup(setupArgs(process.argv.slice(2)), realEnv(), {
    out: (line) => console.log(line),
    interactive: Boolean(rl),
    confirm: (q) =>
      new Promise((resolve) =>
        rl!.question(q, (answer) => resolve(!/^n(o)?$/i.test(answer.trim())))
      ),
  });
  rl?.close();
  process.exit(code);
}

/** `notebooklm-mcp setup …` passes the subcommand along; a direct run does not. */
function setupArgs(args: string[]): string[] {
  return args[0] === 'setup' ? args.slice(1) : args;
}

void main();
