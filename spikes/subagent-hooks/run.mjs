/*
 * THROWAWAY MEASUREMENT STAND -- not a test, not part of any gate.
 *
 * The stand for the customer's complaint 5 (2026-08-21): "Иногда, не всегда,
 * основной агент запускает агентов и ждёт тихо -- в этот момент иконка
 * состояния показывает не спиннер а зелёную галку."
 *
 * A green tick is `idle`, and only two things in this build produce it: a
 * `Stop` hook, or a `Notification` whose type is `agent_completed` or
 * `idle_prompt`. Which of them arrives while subagents are running is not
 * knowable from the code -- it is a fact about the CLI -- so this asks the CLI.
 *
 * ALL THIRTY-ONE hook names the binary carries are registered, not the eleven
 * the product uses: an event we did not register is indistinguishable from
 * silence, and without that the answer would be "we did not find it" rather
 * than "it is not there".
 */

import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * BY HAND AND ON PURPOSE. This starts a real `claude` and spends real tokens on
 * whoever is logged in -- little, but not nothing -- so it refuses to run
 * without being told to, the same way the acceptance stand does. NOTHING in any
 * gate runs this file: the rule it produced is checked against synthetic hook
 * payloads, which cost nothing at all.
 *
 * Owner's instruction, 2026-08-21: "тест с субагентом не должен тратить много
 * токенов", "я бы вообще хотел запускать такой тест только по требованию".
 *
 *   GRIPTERM_LIVE_AGENT=yes node spikes/subagent-hooks/run.mjs
 *
 * What it costs, said out loud: one prompt and two subagents that answer a
 * single word (or sleep). Measured 2026-08-21: about ten thousand tokens per
 * run, two runs.
 */
if (process.env.GRIPTERM_LIVE_AGENT !== 'yes') {
  console.error(
    [
      'This stand starts a real `claude` and spends real tokens on whoever is logged in.',
      'Set GRIPTERM_LIVE_AGENT=yes to mean it.',
    ].join(String.fromCharCode(10))
  );
  process.exit(1);
}

const require = createRequire(`${dirname(dirname(dirname(fileURLToPath(import.meta.url))))}/spikes/pty-screen/`);
const pty = require('node-pty');

const BASE = join(tmpdir(), 'gripterm-subagent-stand');
const SETTINGS = join(BASE, 'settings.json');
const PORT = 39117;

const EVENTS = [
  'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'Elicitation', 'ElicitationResult',
  'FileChanged', 'InstructionsLoaded', 'MessageDisplay', 'Notification', 'PermissionDenied',
  'PermissionRequest', 'PostCompact', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure',
  'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Setup',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'TaskCompleted',
  'TaskCreated', 'TeammateIdle', 'UserPromptExpansion', 'UserPromptSubmit', 'WorktreeCreate',
  'WorktreeRemove',
];

const PROMPT =
  'Launch exactly two subagents with the Task tool, in parallel, in one message. ' +
  'Each subagent must run the Bash command `sleep 60` and then answer with the single word done. ' +
  'While they run, say nothing at all. When both have answered, tell me the two words and stop.';

rmSync(BASE, { recursive: true, force: true });
mkdirSync(BASE, { recursive: true });
writeFileSync(join(BASE, 'README.md'), '# the project of the subagent stand\n', 'utf8');

const hooks = {};
for (const name of EVENTS) {
  hooks[name] = [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${PORT}/hook`, timeout: 5 }] }];
}
writeFileSync(SETTINGS, JSON.stringify({ hooks }, null, 2), 'utf8');

const started = Date.now();
const seen = [];
function stamp() {
  return ((Date.now() - started) / 1000).toFixed(2).padStart(6);
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { unparsed: body.slice(0, 200) };
    }
    const name = payload.hook_event_name ?? '?';
    const extra = [
      payload.tool_name ? `tool=${payload.tool_name}` : '',
      payload.notification_type ? `notification_type=${payload.notification_type}` : '',
      payload.message ? `message=${JSON.stringify(String(payload.message).slice(0, 80))}` : '',
      payload.agent_id ? `agent_id=${payload.agent_id}` : '',
      payload.agent_type ? `agent_type=${payload.agent_type}` : '',
      payload.session_id ? `session=${String(payload.session_id).slice(0, 8)}` : '',
      payload.stop_hook_active === undefined ? '' : `stop_hook_active=${payload.stop_hook_active}`,
    ].filter((one) => one.length > 0).join(' ');
    seen.push({ at: Date.now() - started, name });
    console.log(`${stamp()}  HOOK  ${String(name).padEnd(20)} ${extra}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
});
server.listen(PORT, '127.0.0.1');

const term = pty.spawn(
  'claude.exe',
  ['--settings', SETTINGS],
  { name: 'xterm-256color', cols: 120, rows: 30, cwd: BASE, env: { ...process.env } }
);

let screen = '';
term.onData((data) => {
  screen = (screen + data).slice(-4000);
});

function says(what) {
  // eslint-disable-next-line no-control-regex
  return screen.replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '').includes(what);
}

async function waitFor(what, ready, ms) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) {
      console.log(`${stamp()}  ---  gave up waiting for ${what}`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`${stamp()}  ---  ${what}`);
  return true;
}

await waitFor('the CLI to draw its prompt', () => says('>') || says('bypass'), 60000);
await new Promise((resolve) => setTimeout(resolve, 3000));

term.write(PROMPT);
await new Promise((resolve) => setTimeout(resolve, 1500));
term.write('\r');
console.log(`${stamp()}  ---  prompt sent`);

// Long enough for two subagents to run and the main turn to end.
await new Promise((resolve) => setTimeout(resolve, 240000));

console.log(`${stamp()}  ---  the order of what arrived:`);
console.log(seen.map((one) => `${(one.at / 1000).toFixed(2)} ${one.name}`).join('\n'));
console.log('--- the last of the screen ---');
// eslint-disable-next-line no-control-regex
console.log(screen.replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '').split('\n').slice(-25).join('\n'));

term.kill();
server.close();
process.exit(0);
