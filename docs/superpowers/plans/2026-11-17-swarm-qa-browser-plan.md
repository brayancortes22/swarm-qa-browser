# Swarm QA Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `swarm-qa-browser` as an independent Node.js ESM + Chrome MV3 Extension + MCP + CDP multi-cursor QA and closed-loop Dev verification system, and verify it live against `sonora-music-player`.

**Architecture:** Clean-room monorepo divided into `packages/core` (state machine, exclusive lock manager, secure local WS/HTTP bus), `packages/overlay` (closed-Shadow-DOM multi-cursor HUD, non-destructive DOM/A11y/overflow/collision auditor, pathname-scoped pins), `packages/mcp-server` (stdio MCP tools for Antigravity/Cursor/Claude Code), `packages/extension` (Chrome MV3 with `"debugger"` + explicit user consent UI for `390px` emulation & trusted clicks), and `packages/cdp-adapter` (direct CDP bridge for Antigravity integrated browser coexistence). Every module stays under 150-200 lines with single responsibility.

**Tech Stack:** Node.js `>=20` ESM, `ws` (WebSocket server), Chrome Extension Manifest V3 (`chrome.debugger`, `chrome.permissions`, `chrome.scripting`), Shadow DOM CSS/JS, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-17-swarm-qa-browser-design.md`

## Global Constraints

- Every source file under `packages/` and `scripts/` MUST remain concise and modular (target `<150-200` lines, SRP).
- Zero code copied from `DhvanilPatel/swarm-cursors` (no license). Clean-room implementation only.
- `swarm-bus` binds exclusively to `127.0.0.1`, validates `Origin` (`chrome-extension://<fixed-id>`, `http://127.0.0.1*`, `http://localhost*`, or empty `Origin` for local CLI/MCP), and requires a 24-byte random session bearer token.
- Registry file defaults to `~/.swarm-qa-browser/bus.json` (overridable via `SWARM_REGISTRY_PATH` for isolated tests) with stale-PID replacement.
- `manifest.json` pins a deterministic `"key"`, uses `"permissions": ["activeTab", "scripting", "storage", "debugger"]`, `"host_permissions": ["http://localhost/*", "http://127.0.0.1/*"]`, and `"optional_host_permissions": ["http://*/*", "https://*/*"]`.
- Overlay runs strictly in `ISOLATED` world / `Page.createIsolatedWorld` inside closed `ShadowRoot` (`#__swarm_qa_overlay`). Extracted DOM/console text is sanitized, truncated to 280 chars, redacts `password`/`hidden` values as `[redacted]`, and is flagged `untrustedPageData: true`.
- Ticket `round` starts at `1`, allows up to 3 fix attempts (`round < 3` reopens with `round + 1`; failing at `round === 3` transitions to `escalated`).

## Review Focus

- Stale `~/.swarm-qa-browser/bus.json` left after a dead process: bus discovery must probe `/health` or PID liveness and safely replace stale locks (pinned in Task 2/3 tests).
- Cross-Site WebSocket Hijacking & prompt injection via webpage text: bus must reject `Origin: https://evil.example` with `403`, and auditor/network payloads must sanitize control chars and redact passwords (pinned in Task 3 & Task 5 tests).
- Concurrent interactive/viewport lock contention: `lock-manager` must block a second `agentId` while locked, allow idempotent renewal by owner, and expire cleanly past TTL (pinned in Task 2 tests).
- Ticket escalation off-by-one boundary: verify exact 3-attempt lifecycle (`open` -> round 1 fail -> round 2 fail -> round 3 fail -> `escalated`, refusing further `claim`) (pinned in Task 2 tests).
- Chrome MV3 Service Worker reconnect & SPA route pin filtering: `issue-pins` filters visible pins by active `pathname` without deleting tickets on other routes (pinned in Task 4/5/7).

---

### Task 1: Extension Key Generator & Manifest Key Provisioning

**Files:**
- Create: `scripts/generate-extension-key.mjs`

**Interfaces:**
- Produces: deterministic Chrome MV3 `"key"` base64 SPKI string and derived 32-char extension ID (`a`-`p` alphabet from first 16 bytes of SHA-256 of SPKI DER), saved or printed for `manifest.json` and `session-auth.mjs` defaults via helper `computeExtensionId(base64Spki)`.

- [ ] **Step 1: Implement `scripts/generate-extension-key.mjs`**
  Export `computeExtensionId(base64Key)` and CLI runner that writes/reads a deterministic keypair into `.swarm/extension-key.json` (or prints JSON `{ key, extensionId }`) using `node:crypto` (`generateKeyPairSync('rsa', { modulusLength: 2048 })`).
- [ ] **Step 2: Run `node scripts/generate-extension-key.mjs` and verify output**
  Expected: outputs a valid 32-character `[a-p]{32}` `extensionId` and base64 SPKI `key`.

---

### Task 2: `[P]` Core Domain Modules (`roles`, `ticket-store`, `lock-manager`, `session-auth`)

**Files:**
- Create: `packages/core/src/roles.mjs`
- Create: `packages/core/src/ticket-store.mjs`
- Create: `packages/core/src/lock-manager.mjs`
- Create: `packages/core/src/session-auth.mjs`
- Test: `test/ticket-store.test.mjs`, `test/lock-manager.test.mjs`

**Interfaces:**
- `roles.mjs` produces: `DEFAULT_ROLES` map (`layout`, `responsive`, `forms-a11y`, `console-net`, `interactive`) and `resolveRole(roleOrAgent)`.
- `ticket-store.mjs` produces: `TicketStore` class with `create(input)`, `get(id)`, `list(filter?)`, `claim(ids, devAgentId)`, `markFixed(ids, summary)`, `verify(id, { agentId, passed, evidence })`, and `sanitizePageText(str)`.
- `lock-manager.mjs` produces: `LockManager` class with `acquire({ agentId, scope, tabId, ttlMs })`, `release({ agentId, tabId })`, `status(tabId?)`, `assertCanMutate({ agentId, tabId })`.
- `session-auth.mjs` produces: `getRegistryPath()`, `createToken()`, `isAllowedOrigin(origin, allowedExtensionId)`, `readBusRegistry()`, `writeBusRegistry(info)`, `clearBusRegistryIfOwned(pid)`.

- [ ] **Step 1: Write failing tests in `test/ticket-store.test.mjs` and `test/lock-manager.test.mjs`**
  Test exact 3-round escalation (`round` 1 -> 2 -> 3 -> `escalated` refusing further `claim`), `tabId`/`pathname`/`viewport` scoping, text sanitization (`untrustedPageData: true`, truncation at 280 chars), and lock mutual exclusion + TTL expiry + dead-PID registry cleanup.
- [ ] **Step 2: Run `node --test test/ticket-store.test.mjs test/lock-manager.test.mjs` to confirm RED**
- [ ] **Step 3: Implement `roles.mjs`, `ticket-store.mjs`, `lock-manager.mjs`, `session-auth.mjs` (<150 lines each)**
- [ ] **Step 4: Run tests to confirm GREEN**

---

### Task 3: Local WebSocket/HTTP Bus (`swarm-bus.mjs`, `cli-bus.mjs`)

**Files:**
- Create: `packages/core/src/swarm-bus.mjs`
- Create: `packages/core/src/cli-bus.mjs`
- Test: `test/swarm-bus-security.test.mjs`

**Interfaces:**
- Consumes: `TicketStore`, `LockManager`, `session-auth.mjs`, `ws` (`WebSocketServer`).
- Produces: `startSwarmBus({ port, host, registryPath, extensionId })` returning `{ port, token, url, close(), store, locks, waitForEvent(sinceSeq, timeoutMs), dispatchToTab(tabId, command) }`.
- Endpoints: `GET /health` (minimal `{ ok, port }`), `POST /pair` (requires valid Chrome Extension `Origin` or local CLI, returns `{ port, token, extensionId }`), `POST /rpc` (auth token required), WS `/` (`?token=` + strict `Origin` check, bidirectional tab registration `hello`, `command`, `command_result`, `event` broadcast).

- [ ] **Step 1: Write failing tests in `test/swarm-bus-security.test.mjs`**
  Assert: `Origin: https://evil.example` rejected `403` on HTTP & WS; missing/wrong token rejected `401`/`403`; stale `bus.json` with dead PID replaced cleanly; full WS tab registration + command dispatch round-trip + `waitForEvent` wakeup works.
- [ ] **Step 2: Run test to verify RED**
- [ ] **Step 3: Implement `swarm-bus.mjs` (<190 lines) and `cli-bus.mjs` (<60 lines)**
- [ ] **Step 4: Run `node --test test/swarm-bus-security.test.mjs` to confirm GREEN**

---

### Task 4: `[P]` Clean-Room Overlay Visuals (`cursor-layer`, `issue-pins`, `network-console`)

**Files:**
- Create: `packages/overlay/src/cursor-layer.js`
- Create: `packages/overlay/src/issue-pins.js`
- Create: `packages/overlay/src/network-console.js`

**Interfaces:**
- `cursor-layer.js` produces: `createCursorLayer(shadowRoot)` with `upsertCursor({ id, label, color, x, y, status, box })`, `removeCursor(id)`, `clearAll()`.
- `issue-pins.js` produces: `createIssuePins(shadowRoot, callbacks)` with `setTickets(tickets, currentPathname)`, `updateSummary(stats)`, and bottom collapsible HUD bar (`#__swarm_qa_overlay`).
- `network-console.js` produces: `MAIN_WORLD_PROBE_SOURCE` string (~30 lines, nonce-tagged `CustomEvent` capturing `console.error`, `unhandledrejection`, `fetch >= 400`) and `createConsoleCollector(nonce)` reading sanitized events in `ISOLATED` world.

- [ ] **Step 1: Implement `cursor-layer.js`, `issue-pins.js`, `network-console.js` (<150 lines each)**

---

### Task 5: `[P]` Non-Destructive DOM Auditor, Overlay Entry & Bundler

**Files:**
- Create: `packages/overlay/src/dom-auditor.js`
- Create: `packages/overlay/src/overlay-entry.js`
- Create: `scripts/build-overlay.mjs`
- Test: `test/dom-auditor.test.mjs`

**Interfaces:**
- `dom-auditor.js` produces: pure check runners + `runDomAudit({ rootDocument, checks, viewport })` detecting:
  1. `overflow` (`scrollWidth > clientWidth` horizontal overflow),
  2. `overlap` (sibling text/control bounding-box collisions),
  3. `a11y` (buttons/links/inputs lacking accessible label or broken `for=`, `password`/`hidden` redacted),
  4. `media` (`img` with `complete && naturalWidth === 0`),
  5. `tap-target` (interactive elements `<44x44px` when `viewport.width <= 480`).
- `overlay-entry.js` produces: `mountSwarmOverlay(options)` returning controller `{ spawnCursors, moveCursor, runAudit, setTickets, setRoute, destroy }` (never leaks to `window` in `ISOLATED` world).
- `scripts/build-overlay.mjs` builds `packages/extension/overlay.bundle.js` and `packages/cdp-adapter/overlay.bundle.js` cleanly with zero external bundler deps.

- [ ] **Step 1: Write failing tests in `test/dom-auditor.test.mjs`**
  Use deterministic mock DOM nodes/rects to assert detection of horizontal overflow, overlapping bounding boxes, missing accessible button labels, broken image (`naturalWidth: 0`), small mobile tap target `<44px` at `390px`, and password value redaction.
- [ ] **Step 2: Run test to verify RED**
- [ ] **Step 3: Implement `dom-auditor.js`, `overlay-entry.js`, `scripts/build-overlay.mjs`**
- [ ] **Step 4: Run `node scripts/build-overlay.mjs` and `node --test test/dom-auditor.test.mjs` to confirm GREEN**

---

### Task 6: `[P]` Universal MCP Server (`tool-schemas`, `mcp-server`)

**Files:**
- Create: `packages/mcp-server/src/tool-schemas.mjs`
- Create: `packages/mcp-server/src/mcp-server.mjs`
- Test: `test/mcp-server.test.mjs`

**Interfaces:**
- Exposes stdio JSON-RPC 2.0 MCP tools: `swarm_session_status`, `swarm_select_tab`, `swarm_spawn_cursors`, `swarm_move_cursor`, `swarm_acquire_lock`, `swarm_release_lock`, `swarm_set_viewport`, `swarm_click`, `swarm_fill`, `swarm_press_key`, `swarm_navigate`, `swarm_run_dom_audit`, `swarm_report_finding`, `swarm_list_findings`, `swarm_claim_findings`, `swarm_mark_fixed`, `swarm_verify_finding`, `swarm_await_event`.
- Attaches to active bus from registry or starts a new bus automatically.

- [ ] **Step 1: Write failing tests in `test/mcp-server.test.mjs`**
  Test `initialize`, `tools/list`, and end-to-end `tools/call` against a live mock tab over WebSocket (`swarm_run_dom_audit` -> `swarm_claim_findings` -> `swarm_mark_fixed` -> `swarm_verify_finding` + `swarm_report_finding`).
- [ ] **Step 2: Run test to verify RED**
- [ ] **Step 3: Implement `tool-schemas.mjs` (<140 lines) and `mcp-server.mjs` (<195 lines)**
- [ ] **Step 4: Run `node --test test/mcp-server.test.mjs` to confirm GREEN**

---

### Task 7: `[P]` Chrome Extension MV3 (`manifest`, `background`, `content`, `popup`)

**Files:**
- Create: `packages/extension/manifest.json`
- Create: `packages/extension/background.js`
- Create: `packages/extension/content.js`
- Create: `packages/extension/popup.html`
- Create: `packages/extension/popup.js`

**Interfaces:**
- `manifest.json`: pinned `"key"` from Task 1, `"permissions": ["activeTab", "scripting", "storage", "debugger"]`, `"host_permissions": ["http://localhost/*", "http://127.0.0.1/*"]`, `"optional_host_permissions": ["http://*/*", "https://*/*"]`.
- `popup.html` / `popup.js`: Refero AAA dark consent UI explaining `"debugger"` banner + `390px` emulation + `chrome.permissions.request()` for non-localhost origins + Connect/Authorize Session + Revoke/Detach button + JSON report export.
- `background.js`: keeps authenticated WS connection to `127.0.0.1:47921` (with reconnect alarm/retry), executes `chrome.debugger` CDP commands (`Emulation.setDeviceMetricsOverride`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Page.navigate`, `Runtime.exceptionThrown`/`Network.responseReceived`) ONLY on explicitly user-authorized tabs, and bridges `content.js`.
- `content.js`: runs in `ISOLATED` world, mounts `overlay.bundle.js`, watches SPA `pushState`/`popstate` to update `issue-pins`, and injects `MAIN_WORLD_PROBE_SOURCE` via `chrome.scripting` when non-debugger fallback is needed.

- [ ] **Step 1: Implement all 5 extension files (<180 lines each) and rebuild overlay bundle (`npm run build:overlay`)**

---

### Task 8: `[P]` Antigravity / Headless CDP Adapter (`cdp-bridge.mjs`)

**Files:**
- Create: `packages/cdp-adapter/src/cdp-bridge.mjs`

**Interfaces:**
- CLI/module `connectCdpBridge({ cdpUrl, port, targetFilter, busRegistryPath })` attaching to an existing Chromium CDP target (`type === 'webview'` or `'page'`), executing `Page.createIsolatedWorld` + `overlay.bundle.js`, registering as a live tab on `swarm-bus`, and forwarding `set_viewport`, `click`, `fill`, `press_key`, `navigate`, `run_audit`, `move_cursor` without colliding with `#__antigravity_native_browser_ui`.

- [ ] **Step 1: Implement `cdp-bridge.mjs` (<190 lines) using `ws` + `node:http`**

---

### Task 9: Documentation, Full Verification & Live Test on `sonora-music-player`

**Files:**
- Create: `README.md`
- Update: `docs/architecture.md`

- [ ] **Step 1: Write `README.md` & `docs/architecture.md` documenting installation, MCP config, Chrome Extension loading, and security boundaries.**
- [ ] **Step 2: Run `npm run build:overlay && npm test` in `swarm-qa-browser` and confirm 100% passing with zero warnings.**
- [ ] **Step 3: Visually audit `popup.html` and live multi-cursor overlay on `sonora-music-player` (`development` branch, Vite dev server) at `1440×900` and `390×844` using `antigravity-native-browser` / `qa-annotator`, verifying real findings -> fix -> `verified` cycle.**
