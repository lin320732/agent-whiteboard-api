# Agent Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents fetch centrally maintained operating instructions from one stable authenticated URL.

**Architecture:** Bundle the existing handbook from its Markdown source; append immutable D1 revisions of administrator guidance. An authenticated versioned endpoint serves the guide, while public discovery contains only its path. The console allows administrators to publish guidance with optimistic concurrency.

**Tech Stack:** Cloudflare Workers/D1, browser JS, Node SQLite tests, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-agent-guide.md`

## Global Constraints

- Preserve account a4a41234, real D1 IDs, tasks, scores and credentials; backup before additive migration 0005.
- Read requires personal credentials. Publish requires an admin session and same origin.
- Guidance is at most 12000 characters. Empty text clears it. Stale versions return 409.
- Agent scheduling remains external; no production test instructions or Agent impersonation.

## Review Focus

- Conditional reads cannot bypass auth: test anonymous matching ETag and revoked credentials.
- Concurrent editor publishes cannot overwrite another revision: SQLite CAS test.
- Built-in Markdown cannot drift from deployed text: generator parity test.
- Private guidance must not leak through public discovery: health/list shape test.
- Failed save or hostile markup must preserve safe UI and draft: browser test.

### Task 1: Versioned guide API and discovery

**Files:** Create `src/agent-guide.js`, `src/agent-guide-content.js` (generated), `scripts/build-agent-guide.mjs`, `migrations/0005-agent-guide.sql`, `test/agent-guide.test.mjs`; modify `src/index.js`, `src/collaboration.js`, `docs/AGENT_LOOP.md`, `wrangler.toml`.
**Interfaces:** `initAgentGuide(db)` initializes additive schema; `agentGuideRoute(request,env,principal,path)` returns Response or null; `GUIDE_DISCOVERY` is a static path/check policy, never private text. GET `/api/agent-guide` returns `{version,markdown,instructions,updated_at,bootstrap,entrypoints}` with ETag. POST `/api/admin/agent-guide` accepts `{version,instructions}`.

- [ ] Write tests for personal auth, admin-only updates, wrong origin, revision conflict, clear/max length, ETag invalidation and doc parity; watch them fail.
- [ ] Implement generated content, schema, versioned reads, atomic append and discovery in health/tasks/inbox.
- [ ] Run Node suites and local Worker regression; commit.

### Task 2: Console guide management and release

**Files:** Create `web/agent-guide.js`, `test/agent-guide.playwright.js`; modify `web/app.js`, `web/index.html`, `web/style.css`, `README.md`, `DEPLOY.md`.
**Interfaces:** `createAgentGuideUI({api,node,button,user,notify})` exposes `refresh()` and `reset()`; UI reads endpoint from Task 1 and submits its current version. Refresh preserves unsaved editor text.

- [ ] Add browser checks for publish, failed-save drafts, content safety and viewer restrictions; observe failure.
- [ ] Implement read-only guide view, admin editor and one-time bootstrap copy affordance.
- [ ] Run browser fixtures, Node tests, both dry-runs; self-review and commit.
- [ ] Fetch upstream main, back up D1, migrate, push/deploy; authenticated read-only live checks and session cleanup; record release.
