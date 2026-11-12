import type { Action } from './actions.js';
import type { Observation, ObservedElement } from './observe.js';
import type { StepLog } from './types.js';

export const SYSTEM_PROMPT = `You are an automated QA engineer controlling a real web browser to execute ONE test case written in plain English.
Each turn you receive the test case, a log of the steps so far, and the current page: a numbered list of interactive elements plus the visible text. Reply by calling next_action with exactly ONE action.

Rules:
1. Do what the test case says, using only what is visible on the page. Never invent data, credentials, URLs or element ids.
2. Refer to elements ONLY by the id numbers in the CURRENT list. Ids change after every step.
3. A value written as {{name}} is a secret placeholder. Type it exactly as written, including the braces. Never guess its value.
4. If the test needs information (credentials, names, numbers) that is neither in the test case nor visible on the page, finish with verdict FAIL and a reason that starts with 'missing data:'.
5. A test PASSES only if you verified its expected outcome with assert_text, assert_no_text or assert_url and that assertion passed. An action that did not error is NOT proof. Your assertion must be the last action before you finish PASS.
6. If the expected outcome is not observed, the app shows an error, or you cannot continue after reasonable attempts, finish with FAIL and describe what you saw.
7. Dismiss cookie banners or popups only if they block the task.
8. Be efficient: do not repeat an action that already worked, and the number of steps is limited.
9. Keep 'thought' to one short sentence.`;

const q = (s: string): string => `'${s}'`;

export function describeAction(a: Action, label: string): string {
  switch (a.action) {
    case 'goto': return `goto ${a.url}`;
    case 'click': return `click [${a.id}] ${q(label)}`;
    case 'type': return `type ${q(a.text)} into [${a.id}] ${q(label)}${a.submit ? ' and press Enter' : ''}`;
    case 'select': return `select ${q(a.text)} in [${a.id}] ${q(label)}`;
    case 'press': return `press ${a.key}`;
    case 'scroll': return `scroll ${a.text ?? 'down'}`;
    case 'wait': return `wait ${a.ms ?? 1000}ms`;
    case 'assert_text': return `assert page contains ${q(a.text)}`;
    case 'assert_no_text': return `assert page does not contain ${q(a.text)}`;
    case 'assert_url': return `assert URL contains ${q(a.text)}`;
    case 'finish': return `finish ${a.verdict}`;
  }
}

function formatElement(e: ObservedElement): string {
  const head = [`[${e.id}] ${e.role}`];
  if (e.name) head.push(JSON.stringify(e.name));
  const extra: string[] = [];
  if (e.role === 'textbox' && e.type && e.type !== 'text') extra.push(`type=${e.type}`);
  if (e.placeholder) extra.push(`placeholder=${JSON.stringify(e.placeholder)}`);
  if (e.value) extra.push(`value=${JSON.stringify(e.value)}`);
  if (e.checked) extra.push('checked');
  if (e.disabled) extra.push('disabled');
  if (e.href) extra.push(`href=${e.href}`);
  if (e.options.length) extra.push(`options=${e.options.join(' | ')}`);
  return extra.length ? `${head.join(' ')} (${extra.join(', ')})` : head.join(' ');
}

export function buildUserPrompt(p: {
  test: string;
  startUrl?: string;
  step: number;
  maxSteps: number;
  history: StepLog[];
  obs: Observation;
  hint: string;
}): string {
  const recent = p.history.slice(-12);
  const skipped = p.history.length - recent.length;
  const log = recent.length
    ? recent.map((s) => `${s.n}. ${s.description} -> ${s.ok ? 'ok' : 'FAILED'}${s.note ? ` (${s.note})` : ''}`).join('\n')
    : 'none yet';
  const elements = p.obs.elements.length
    ? p.obs.elements.map(formatElement).join('\n')
    : '(no interactive elements found)';
  const more = p.obs.notShown > 0 ? `\n(${p.obs.notShown} more elements not shown; scroll to reveal)` : '';
  return [
    `TEST CASE:\n${p.test}`,
    p.startUrl ? `The browser has already opened: ${p.startUrl}` : 'No page is open yet. Use goto with a URL from the test case.',
    `STEP ${p.step} of ${p.maxSteps}.`,
    `STEPS SO FAR${skipped > 0 ? ` (${skipped} earlier steps omitted)` : ''}:\n${log}`,
    p.hint ? `NOTE FROM THE RUNNER: ${p.hint}` : '',
    `CURRENT PAGE\nURL: ${p.obs.url}\nTitle: ${p.obs.title}\n\nInteractive elements (use these ids):\n${elements}${more}\n\nVisible text:\n${p.obs.text}`,
  ].filter(Boolean).join('\n\n');
}