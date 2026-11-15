# Whiteboard Display Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator edit existing human and Agent display names without changing credentials, ongoing claims, or stored attribution.

**Architecture:** Keep `principals.name` as the stable actor identity used for claim authorization and scoring. Save editable labels in a separate D1 table, show them in account/session responses, and project business API actor fields to the current label on read. Add an inline editor to the existing account list.

**Tech Stack:** Cloudflare Worker + D1 SQL, plain browser JS/CSS, Node test runner and Playwright CLI.

**Spec:** User request to change display names; `README.md` identity and admin API sections; `docs/superpowers/specs/2026-11-15-whiteboard-console.md` security model.

## Global Constraints

- Keep account usernames, roles, passwords, API tokens, sessions, D1 business rows, and original attribution unchanged on rename.
- Only a logged-in administrator from the board origin can rename; validate 1–80 nonblank characters, trim outer whitespace, and return 404 for a missing account.
- Existing task ownership, review rules, and leaderboard totals remain stable across rename; the new label appears on the board and API responses.
- Keep credentials out of Git, logs, browser URL parameters, and the response from the rename endpoint.

## Review Focus

- An Agent with an `in_progress` claim can submit after changing its label; use a real D1-backed request test.
- Readiness and leaderboard must still count one participant and one score account across rename; test the same Agent before/after.
- Session and Agent token remain valid; unauthorized, cross-origin, malformed, missing, and disabled account cases are explicitly tested.
- An old actor name shared by multiple accounts must not cause another account's history to be relabeled; fail safe on ambiguous mappings.
- Inline edit, cancel, self edit, disabled account edit, 403 error, and periodic refresh must work without losing the draft; test in the browser.

---

### Task 1: Backend label persistence and safe projection

**Files:** Modify `src/auth.js`, `src/index.js`, `test/auth.test.mjs`, `README.md`; create `migrations/0002-display-names.sql`.

**Interfaces:** `POST /api/admin/{users|agents}/:id/name` with `{name}` returns `{ok,id,name}`; `GET /api/admin/{users|agents}` and `/api/auth/me` return current display label as `name`; authenticated business APIs present current actor label while D1 and authorization use immutable `principals.name`.

- [ ] Add failing tests for rights, validation, session/token continuity, active claim, leaderboard/readiness consistency, and projection of existing task/messages/debate records.
- [ ] Run focused tests and inspect the failures.
- [ ] Add the idempotent table migration, rename endpoint, and response projection while keeping raw actor identity unchanged.
- [ ] Run focused tests and the existing API suite; expect all to pass.

### Task 2: Inline account editor

**Files:** Modify `web/app.js`, `web/style.css`, `test/admin-actions.playwright.js`.

**Interfaces:** Add a “改名” button to every account row. The inline form preloads the current label and POSTs the new one to the admin endpoint; cancel and failures leave it unchanged. Editing self updates the signed-in header immediately.

- [ ] Extend browser fixture for Agent, self, disabled, validation failure, cancel, no credential rotation, and manual refresh preserving the editor.
- [ ] Run it against the old UI; expect the editor assertion to fail.
- [ ] Implement inline editing and feedback, using the existing account controls style and safe text nodes.
- [ ] Run browser fixture, existing frontend fixture, API tests, and Wrangler dry-runs.

### Release

- [ ] Recheck GitHub `main`; back up D1 and apply `migrations/0002-display-names.sql` to the remote D1 before deploying the API Worker.
- [ ] Push reviewed code to GitHub `main` and deploy API then board with cfcm `a4a41234`.
- [ ] Verify both live Workers, task 5, endpoint authentication, asset hashes, and a clean local `main`.
