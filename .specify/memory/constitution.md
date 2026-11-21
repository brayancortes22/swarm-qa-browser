# Swarm QA Browser Constitution

## Core Principles

### I. Non-destructive by default
The overlay never deletes or rewrites page nodes. Every change it makes to an inspected page (tour styles, hot patches) is reversible and is reverted when the work ends, is cancelled, or the overlay is destroyed. A test must prove the page is restored exactly.

### II. Local and authenticated
The bus binds to loopback only, rejects foreign origins, and requires the per-session token on every call. The extension obtains that token only with the pairing code. No secret is ever hardcoded or logged.

### III. Page data is untrusted
Any text coming from an inspected page is sanitized, length-limited, and flagged `untrustedPageData: true`. Sensitive field values are redacted. Patches are validated data, never raw CSS, HTML or script.

### IV. Verified, not claimed (NON-NEGOTIABLE)
A ticket becomes `verified` only when a fresh audit no longer reports the finding. Documentation states only what code and tests support; if a capability has no test, it is listed as pending.

### V. Real-time on the page
Animation runs inside the page at display refresh rate. Transports carry high-level commands and events, so motion never depends on bus latency.

### VI. Small modules, one responsibility
Each source file has a single purpose and a doc comment explaining it. Prefer plain data and pure functions that can be unit-tested without a browser.

## Quality Gates

- `npm run lint`, `npm run format:check` and `npm test` pass before merging.
- Changes to the overlay, adapters or bus also pass `npm run test:e2e` in a real Chromium.
- Mutating commands require the tab lock; read-only roles cannot mutate.

## Development Workflow

- Work on feature branches from `development`; open a pull request with the tests that cover the change.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Generated files (`overlay.bundle.js`) are never committed.

## Governance

This constitution overrides conflicting guidance in older planning documents. Amendments are made by pull request, with the reason for the change and any migration it requires.

**Version**: 1.0.0 | **Ratified**: 2026-11-21 | **Last Amended**: 2026-11-21
