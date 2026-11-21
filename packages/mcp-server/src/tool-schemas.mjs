const TEXT = { type: 'string', description: 'Visible text of the target element (alternative to selector)' };
const NUM = { type: 'number' };
const TAB = { type: ['string', 'number'], description: 'Target browser tab ID (defaults to selected tab)' };
const AGENT = { type: 'string', description: 'Agent or role ID (e.g. layout, responsive, interactive, dev-1)' };
const VP = { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } };
const RECT = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    left: { type: 'number' },
    top: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' }
  }
};
const IDS = { type: 'array', items: { type: 'string' }, description: 'List of ticket IDs' };
const RO = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
const IDEMP = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
const ACT = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });

const tool = (name, description, properties = {}, required = [], annotations = ACT) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
  annotations
});

/**
 * MCP tool descriptors for the Swarm QA Browser closed-loop verification server.
 */
export const SWARM_TOOLS = Object.freeze([
  tool('swarm_session_status', 'Inspect connected tabs, active locks, roles, event seq, and ticket counts.', { tabId: TAB }, [], RO),
  tool('swarm_select_tab', 'Select the default active browser tab for subsequent swarm operations.', { tabId: TAB }, ['tabId'], IDEMP),
  tool(
    'swarm_spawn_cursors',
    'Spawn or reset multi-cursor QA overlays on the target browser tab.',
    {
      tabId: TAB,
      clear: { type: 'boolean' },
      roles: { type: 'array', items: { type: 'string' }, description: 'Role names to spawn (defaults to all DEFAULT_ROLES)' },
      cursors: { type: 'array', items: { type: 'object' }, description: 'Explicit cursor descriptors' }
    },
    [],
    IDEMP
  ),
  tool(
    'swarm_move_cursor',
    'Move or update status/highlight box for an agent cursor on the overlay.',
    {
      tabId: TAB,
      agentId: AGENT,
      id: { type: 'string' },
      role: { type: 'string' },
      label: { type: 'string' },
      color: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      status: { type: 'string' },
      selector: { type: 'string' },
      box: { type: 'object' }
    },
    [],
    IDEMP
  ),
  tool(
    'swarm_configure_swarm',
    'Configure the autonomous cursor swarm on a tab: number of agents (0-32), animation speed (1, 2 or 4), sound, rulers, or minimize the HUD.',
    {
      tabId: TAB,
      agents: { type: 'number' },
      speed: { type: 'number' },
      sound: { type: 'boolean' },
      rulers: { type: 'boolean' },
      minimized: { type: 'boolean' }
    },
    [],
    IDEMP
  ),
  tool(
    'swarm_start_tour',
    'Start the live "rebuild" tour: the swarm hides the page layers and rebuilds them one by one with selection boxes, typing and auto-scroll. Purely visual and fully reversible.',
    {
      tabId: TAB,
      agents: { type: 'number', description: 'Agents to ramp up to (default 14)' },
      speed: { type: 'number' },
      maxLayers: { type: 'number', description: 'Layer cap (default 400)' }
    },
    [],
    ACT
  ),
  tool('swarm_stop_tour', 'Stop a running tour and restore the page immediately.', { tabId: TAB }, [], IDEMP),
  tool(
    'swarm_acquire_lock',
    'Acquire or renew the exclusive mutation/viewport lock on a tab.',
    {
      agentId: AGENT,
      tabId: TAB,
      scope: { type: 'string' },
      ttlMs: { type: 'number' }
    },
    ['agentId'],
    IDEMP
  ),
  tool(
    'swarm_release_lock',
    'Release an active tab mutation/viewport lock held by agentId.',
    {
      agentId: AGENT,
      tabId: TAB
    },
    ['agentId'],
    IDEMP
  ),
  tool(
    'swarm_set_viewport',
    'Emulate viewport dimensions (e.g. 390x844 mobile or 1440x900 desktop) under lock protection.',
    {
      tabId: TAB,
      agentId: AGENT,
      width: { type: 'number' },
      height: { type: 'number' },
      mobile: { type: 'boolean' },
      deviceScaleFactor: { type: 'number' }
    },
    ['width', 'height'],
    IDEMP
  ),
  tool(
    'swarm_click',
    'Dispatch a real trusted click by CSS selector, visible text or coordinates under lock protection.',
    {
      tabId: TAB,
      agentId: AGENT,
      selector: { type: 'string' },
      text: TEXT,
      x: { type: 'number' },
      y: { type: 'number' },
      button: { type: 'string' },
      clickCount: { type: 'number' }
    },
    [],
    ACT
  ),
  tool(
    'swarm_fill',
    'Focus and fill a form input or textarea (by selector, or by the visible text of its label) under lock protection.',
    {
      tabId: TAB,
      agentId: AGENT,
      selector: { type: 'string' },
      text: TEXT,
      value: { type: 'string' },
      clear: { type: 'boolean' }
    },
    ['value'],
    ACT
  ),
  tool(
    'swarm_press_key',
    'Send a keyboard event (e.g. Enter, Escape, Tab) under lock protection.',
    {
      tabId: TAB,
      agentId: AGENT,
      key: { type: 'string' },
      selector: { type: 'string' },
      modifiers: { type: 'array', items: { type: 'string' } }
    },
    ['key'],
    ACT
  ),
  tool(
    'swarm_navigate',
    'Navigate the target tab to a URL under lock protection.',
    {
      tabId: TAB,
      agentId: AGENT,
      url: { type: 'string' }
    },
    ['url'],
    ACT
  ),
  tool(
    'swarm_run_dom_audit',
    'Run non-destructive DOM/A11y/overflow/media/tap-target/console-net audit and store deduplicated tickets.',
    {
      tabId: TAB,
      agentId: AGENT,
      checks: { type: 'array', items: { type: 'string' } },
      viewport: VP,
      createTickets: { type: 'boolean' },
      animate: { type: 'boolean', description: 'Play the live inspection choreography (default true)' },
      follow: { type: 'boolean', description: 'Let the choreography scroll the page to off-screen findings (default false)' }
    },
    [],
    ACT
  ),
  tool(
    'swarm_report_finding',
    'Report a manual QA finding directly as a ticket and refresh overlay pins.',
    {
      tabId: TAB,
      agentId: AGENT,
      ruleId: { type: 'string' },
      severity: { type: 'string' },
      category: { type: 'string' },
      selector: { type: 'string' },
      pathname: { type: 'string' },
      url: { type: 'string' },
      viewport: VP,
      description: { type: 'string' },
      expected: { type: 'string' },
      actual: { type: 'string' },
      rect: RECT,
      reportedBy: { type: 'string' }
    },
    ['description'],
    ACT
  ),
  tool(
    'swarm_list_findings',
    'List QA finding tickets filtered by status, tabId, pathname, or viewportWidth.',
    {
      tabId: TAB,
      status: { description: 'Status string or array of statuses' },
      pathname: { type: 'string' },
      viewportWidth: { type: 'number' }
    },
    [],
    RO
  ),
  tool(
    'swarm_claim_findings',
    'Claim open or reopened tickets for fixing by a developer agent.',
    {
      ticketIds: IDS,
      devAgentId: { type: 'string', description: 'Developer agent ID claiming the tickets' }
    },
    ['ticketIds', 'devAgentId'],
    ACT
  ),
  tool(
    'swarm_mark_fixed',
    'Mark tickets fixed, wait for HMR, and auto-reverify automated DOM findings on connected tabs.',
    {
      ticketIds: IDS,
      devAgentId: { type: 'string' },
      summary: { type: 'string' },
      waitForHmrMs: { type: 'number', description: 'Milliseconds to wait for HMR before re-audit (default 800, 0 skips)' },
      autoVerify: { type: 'boolean' },
      verifierAgentId: { type: 'string' }
    },
    ['ticketIds'],
    ACT
  ),
  tool(
    'swarm_heal_findings',
    'Self-heal open tickets that have an automatic recipe: apply a reversible hot patch under lock, re-audit, keep it only if the finding is gone (ticket verified) and revert it otherwise. Returns the verified patches to port to source.',
    {
      tabId: TAB,
      ticketIds: IDS,
      agentId: AGENT
    },
    [],
    ACT
  ),
  tool(
    'swarm_verify_finding',
    'Manually verify or reopen/escalate a ticket in awaiting_reverify status.',
    {
      id: { type: 'string', description: 'Ticket ID to verify' },
      agentId: AGENT,
      passed: { type: 'boolean' },
      evidence: { description: 'Verification evidence string or object' }
    },
    ['id', 'passed'],
    ACT
  ),
  tool(
    'swarm_await_event',
    'Long-poll bus events (tab_hello, route_changed, finding_event, ticket updates) after sinceSeq.',
    {
      sinceSeq: { type: 'number' },
      timeoutMs: { type: 'number' }
    },
    [],
    RO
  ),
  // --- Orchestration ---
  tool(
    'swarm_post_message',
    'Write in the on-page mission log: instructions for the swarm, a decision, or a note. Agents report their findings there too.',
    {
      tabId: TAB,
      from: { type: 'string', description: 'Author shown in the log, e.g. the orchestrator name' },
      text: { type: 'string' },
      kind: { type: 'string', enum: ['instruction', 'report', 'decision', 'done', 'note'] },
      color: { type: 'string' }
    },
    ['text'],
    ACT
  ),
  tool(
    'swarm_apply_fix',
    'Apply YOUR OWN fix for an open ticket (CSS declarations or an aria/title/alt/role attribute, optionally on another selector) under lock, re-audit, and keep it only if the finding is gone; otherwise it is reverted.',
    {
      ticketId: { type: 'string' },
      selector: { type: 'string', description: 'Element to patch (defaults to the ticket element)' },
      declarations: { type: 'object', description: 'CSS declarations, e.g. { "flex-wrap": "wrap" }' },
      attr: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } },
      title: { type: 'string' },
      agentId: AGENT
    },
    ['ticketId'],
    ACT
  ),

  // --- Web testing: observe, act, verify ---
  tool(
    'swarm_screenshot',
    'See the page: returns an image of the tab (viewport, or the full page). Image coordinates are CSS pixels usable with swarm_click.',
    {
      tabId: TAB,
      fullPage: { type: 'boolean' },
      format: { type: 'string', enum: ['jpeg', 'png'] },
      quality: NUM
    },
    [],
    RO
  ),
  tool(
    'swarm_snapshot',
    'Read the page as an outline: URL, title, scroll position and the interactive elements (selector, name, type, value, position). Cheaper than a screenshot.',
    {
      tabId: TAB,
      scope: { type: 'string', enum: ['viewport', 'page'] },
      max: NUM
    },
    [],
    RO
  ),
  tool(
    'swarm_hover',
    'Move the real mouse over an element (by selector, visible text or coordinates) to trigger hover states and menus.',
    {
      tabId: TAB,
      agentId: AGENT,
      selector: { type: 'string' },
      text: TEXT,
      x: NUM,
      y: NUM
    },
    [],
    ACT
  ),
  tool(
    'swarm_scroll',
    'Scroll the page: bring an element into view, jump to top/bottom, or scroll by an offset (default: one screen down).',
    {
      tabId: TAB,
      agentId: AGENT,
      selector: { type: 'string' },
      text: TEXT,
      to: { type: 'string', enum: ['top', 'bottom'] },
      by: { type: 'object', properties: { x: NUM, y: NUM } },
      smooth: { type: 'boolean' }
    },
    [],
    ACT
  ),
  tool(
    'swarm_wait_for',
    'Wait until an element (selector or visible text) is visible, hidden, attached or detached. Fails with WAIT_TIMEOUT.',
    {
      tabId: TAB,
      selector: { type: 'string' },
      text: TEXT,
      state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
      timeoutMs: NUM
    },
    [],
    RO
  ),
  tool(
    'swarm_expect',
    'Assert an expected outcome and record it in the test run. Retries until it passes or times out. With reportOnFail, a failure becomes a P1 ticket.',
    {
      tabId: TAB,
      agentId: AGENT,
      description: { type: 'string', description: 'What this step verifies, in plain words' },
      selector: { type: 'string' },
      text: TEXT,
      visible: { type: 'boolean' },
      textIncludes: { type: 'string' },
      valueEquals: { type: 'string' },
      count: NUM,
      urlIncludes: { type: 'string' },
      titleIncludes: { type: 'string' },
      timeoutMs: NUM,
      reportOnFail: { type: 'boolean' }
    },
    [],
    ACT
  ),
  tool(
    'swarm_test_report',
    'Finish a test run: summarizes every recorded action and expectation (web and desktop), writes .qa/test-report-<name>.json and returns pass/fail.',
    {
      name: { type: 'string' },
      reset: { type: 'boolean', description: 'Start a fresh run afterwards (default true)' }
    },
    [],
    ACT
  ),

  // --- Whole-computer control ---
  tool('swarm_desktop_status', 'Check desktop control: platform, screen size and current pointer position.', {}, [], RO),
  tool(
    'swarm_desktop_screenshot',
    'See the whole screen (or a region). Image pixels are screen pixels unless maxWidth downscales it.',
    {
      region: { type: 'object', properties: { x: NUM, y: NUM, width: NUM, height: NUM } },
      maxWidth: NUM,
      quality: NUM
    },
    [],
    RO
  ),
  tool('swarm_desktop_list_windows', 'List the visible top-level windows with id, title, process id and position.', {}, [], RO),
  tool(
    'swarm_desktop_focus_window',
    'Bring a window to the front, by id or by part of its title.',
    { windowId: { type: ['string', 'number'] }, title: { type: 'string' } },
    [],
    ACT
  ),
  tool('swarm_desktop_move', 'Move the real mouse pointer to screen coordinates.', { x: NUM, y: NUM }, ['x', 'y'], ACT),
  tool(
    'swarm_desktop_click',
    'Click the real mouse at screen coordinates (or where it is). Supports left/right/middle and double clicks.',
    {
      x: NUM,
      y: NUM,
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clickCount: NUM
    },
    [],
    ACT
  ),
  tool(
    'swarm_desktop_drag',
    'Press the left button at one point, drag to another and release.',
    { fromX: NUM, fromY: NUM, toX: NUM, toY: NUM },
    ['fromX', 'fromY', 'toX', 'toY'],
    ACT
  ),
  tool(
    'swarm_desktop_scroll',
    'Turn the mouse wheel (deltaY > 0 scrolls down), optionally after moving to a point.',
    { x: NUM, y: NUM, deltaY: NUM, deltaX: NUM },
    [],
    ACT
  ),
  tool('swarm_desktop_type', 'Type text with the real keyboard into whatever has focus.', { text: { type: 'string' } }, ['text'], ACT),
  tool(
    'swarm_desktop_key',
    'Press a key or chord, e.g. "Enter", "ctrl+s", "alt+tab", "win+r".',
    { keys: { type: 'string' } },
    ['keys'],
    ACT
  ),
  tool(
    'swarm_desktop_open',
    'Start a program, or open a file or URL with its default application.',
    {
      target: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } }
    },
    ['target'],
    ACT
  )
]);
