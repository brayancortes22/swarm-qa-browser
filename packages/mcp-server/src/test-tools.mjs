import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const POLL_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (source, keys) => Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
const includes = (haystack, needle) =>
  String(haystack ?? '')
    .toLowerCase()
    .includes(String(needle).toLowerCase());

/** Marks a tool result as ready-made MCP content (used to return images). */
export const asContent = (content) => ({ __mcpContent: content });
export const imageResult = (shot, info) =>
  asContent([
    { type: 'image', data: shot.data, mimeType: shot.mimeType || 'image/jpeg' },
    { type: 'text', text: JSON.stringify(info) }
  ]);

/**
 * Keeps the log of a test run: every action the agent performed and every expectation it checked.
 * `swarm_test_report` turns it into a pass/fail report on disk.
 */
export function createTestRecorder({ now = () => new Date() } = {}) {
  let steps = [];
  let startedAt = null;
  return {
    record(step) {
      startedAt ??= now().toISOString();
      steps.push({ index: steps.length + 1, at: now().toISOString(), ...step });
    },
    report({ name = 'test-run', reset = true, dir = process.env.SWARM_QA_DIR || '.qa' } = {}) {
      const expectations = steps.filter((step) => step.kind === 'expect');
      const failedActions = steps.filter((step) => step.kind === 'action' && !step.ok);
      const failedExpectations = expectations.filter((step) => !step.ok);
      const report = {
        name: String(name).slice(0, 120),
        startedAt,
        finishedAt: now().toISOString(),
        passed: steps.length > 0 && failedActions.length === 0 && failedExpectations.length === 0,
        totals: {
          steps: steps.length,
          actions: steps.length - expectations.length,
          expectations: expectations.length,
          failedActions: failedActions.length,
          failedExpectations: failedExpectations.length
        },
        steps
      };
      const slug =
        report.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'test-run';
      const file = join(dir, `test-report-${slug}.json`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(report, null, 2));
      if (reset) {
        steps = [];
        startedAt = null;
      }
      return { ...report, file };
    }
  };
}

/**
 * Observation and verification tools for web testing: look at the page (screenshot, outline),
 * find elements by visible text, wait for conditions and assert expected outcomes.
 */
export function buildTestTools({ call, recorder, refreshPins, findTab }) {
  const tabCommand = (tabId, command) => call('tab.command', { tabId, command });
  const query = (args) => tabCommand(args.tabId, { action: 'query', ...pick(args, ['selector', 'text']) });

  /** Lets action tools target an element by visible text: resolves `text` to a selector first. */
  async function resolveTarget(args, prefer) {
    if (args.selector || !args.text) return args;
    const hit = await tabCommand(args.tabId, { action: 'query', text: args.text, ...(prefer ? { prefer } : {}) });
    if (!hit.found) throw Object.assign(new Error(`No visible element contains the text "${args.text}"`), { code: 'ELEMENT_NOT_FOUND' });
    return { ...args, selector: hit.selector };
  }

  async function waitFor(args) {
    const state = args.state || 'visible';
    const timeoutMs = Math.max(0, Number(args.timeoutMs ?? 5000));
    const deadline = Date.now() + timeoutMs;
    const satisfied = (hit) =>
      state === 'visible'
        ? hit.found && hit.visible
        : state === 'hidden'
          ? !hit.found || !hit.visible
          : state === 'attached'
            ? hit.found
            : !hit.found;
    let last;
    for (;;) {
      last = await query(args);
      if (satisfied(last))
        return {
          ok: true,
          state,
          waitedMs: timeoutMs - Math.max(0, deadline - Date.now()),
          element: last.found ? pick(last, ['selector', 'tag', 'name', 'text', 'rect']) : null,
          untrustedPageData: true
        };
      if (Date.now() >= deadline)
        throw Object.assign(
          new Error(`Timed out after ${timeoutMs} ms waiting for ${args.selector || `text "${args.text}"`} to be ${state}`),
          { code: 'WAIT_TIMEOUT' }
        );
      await sleep(POLL_MS);
    }
  }

  /** Evaluates every requested assertion once against the live page. */
  async function evaluate(args) {
    const checks = [];
    const add = (check, expected, actual, passed) => checks.push({ check, expected, actual, passed: Boolean(passed) });
    if (args.selector || args.text) {
      const hit = await query(args);
      const wantsVisible = args.visible ?? (args.count === undefined ? true : undefined);
      if (wantsVisible !== undefined)
        add('visible', wantsVisible, Boolean(hit.found && hit.visible), Boolean(hit.found && hit.visible) === wantsVisible);
      if (args.textIncludes !== undefined)
        add('textIncludes', args.textIncludes, hit.text ?? null, hit.found && includes(hit.text, args.textIncludes));
      if (args.valueEquals !== undefined)
        add('valueEquals', args.valueEquals, hit.value ?? null, hit.found && hit.value === String(args.valueEquals));
      if (args.count !== undefined) add('count', args.count, hit.count ?? 0, (hit.count ?? 0) === Number(args.count));
    }
    if (args.urlIncludes !== undefined || args.titleIncludes !== undefined) {
      const page = await tabCommand(args.tabId, { action: 'snapshot', max: 1 });
      if (args.urlIncludes !== undefined) add('urlIncludes', args.urlIncludes, page.url, includes(page.url, args.urlIncludes));
      if (args.titleIncludes !== undefined) add('titleIncludes', args.titleIncludes, page.title, includes(page.title, args.titleIncludes));
    }
    if (!checks.length) throw new Error('swarm_expect needs a target (selector or text) or a page assertion (urlIncludes, titleIncludes)');
    return checks;
  }

  /** Playwright-style expectation: retried until it passes or the timeout elapses. */
  async function expect(args) {
    const deadline = Date.now() + Math.max(0, Number(args.timeoutMs ?? 3000));
    let checks = await evaluate(args);
    while (!checks.every((c) => c.passed) && Date.now() < deadline) {
      await sleep(POLL_MS);
      checks = await evaluate(args);
    }
    const passed = checks.every((c) => c.passed);
    const description = args.description || checks.map((c) => `${c.check} = ${JSON.stringify(c.expected)}`).join(', ');
    recorder.record({
      kind: 'expect',
      tool: 'swarm_expect',
      target: args.selector || args.text || 'page',
      description,
      ok: passed,
      checks
    });
    let ticket = null;
    if (!passed && args.reportOnFail) {
      const status = await call('session.status', {});
      const tab = findTab(status, args.tabId);
      const failed = checks.filter((c) => !c.passed);
      ticket = await call('tickets.create', {
        tabId: tab?.tabId ?? null,
        url: tab?.url ?? '',
        pathname: tab?.pathname ?? '/',
        viewport: tab?.viewport ?? null,
        ruleId: 'expectation-failed',
        severity: 'P1',
        category: 'functional',
        selector: args.selector || '',
        description: `Expectation failed: ${description}`,
        expected: failed.map((c) => `${c.check}: ${JSON.stringify(c.expected)}`).join('; '),
        actual: failed.map((c) => `${c.check}: ${JSON.stringify(c.actual)}`).join('; '),
        reportedBy: args.agentId || 'test-agent'
      });
      if (tab) await refreshPins([tab.tabId]);
    }
    return { passed, description, checks, ...(ticket ? { ticketId: ticket.id } : {}), untrustedPageData: true };
  }

  return {
    resolveTarget,
    tools: {
      async swarm_screenshot(a) {
        const shot = await tabCommand(a.tabId, { action: 'screenshot', ...pick(a, ['format', 'quality', 'fullPage']) });
        return imageResult(shot, {
          width: shot.width,
          height: shot.height,
          fullPage: shot.fullPage,
          note: 'Coordinates in this image are CSS pixels: use them directly with swarm_click / swarm_hover.',
          untrustedPageData: true
        });
      },
      swarm_snapshot: (a) => tabCommand(a.tabId, { action: 'snapshot', ...pick(a, ['scope', 'max']) }),
      swarm_wait_for: waitFor,
      swarm_expect: expect,
      swarm_test_report: (a) => recorder.report(pick(a, ['name', 'reset']))
    }
  };
}
