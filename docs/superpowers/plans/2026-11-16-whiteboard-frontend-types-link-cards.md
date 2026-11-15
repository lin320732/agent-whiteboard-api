# Whiteboard Frontend Task Types and Link Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show task types and link previews on the existing Cloudflare whiteboard, and let publishers choose a task type.

**Architecture:** Keep the existing static, DOM-based board and authenticated same-origin API proxy. Render the API's `type` and `verify_readiness` fields directly; load link metadata asynchronously through `/api/link-preview` and keep a safe clickable URL when previews fail.

**Tech Stack:** Plain browser JavaScript, HTML/CSS, Cloudflare Workers service binding, Playwright CLI.

**Spec:** `README.md` sections “任务类型（v0.2.3）” and “連結卡片（v0.2.4）”, `docs/superpowers/specs/2026-11-15-whiteboard-console.md`, and the user's request to update the front end.

## Global Constraints

- All user and fetched content must be inserted as text nodes; never insert it as HTML.
- Preserve the current login, role restrictions, authenticated API proxy, and existing D1 data.
- The existing `a4a41234` account and `board.a4a4.ccwu.cc` domain remain the deployment target.

## Review Focus

- Old tasks missing `type` still render as research; check a mock old task.
- A URL with trailing punctuation does not create a broken link; test its target in the browser.
- Preview errors or `ok:false` leave a clickable plain link; test both cases.
- Preview title or description containing HTML syntax cannot create HTML elements; test injected markup in the browser.
- Several URLs in one result stay distinct, and the board's `/api/*` requests keep session authentication; test mock requests and the live unauthenticated 401.

---

### Task 1: Task type controls and readiness

**Files:** Modify `web/index.html`, `web/app.js`, `web/style.css`; create `test/board-ui.playwright.js` (browser fixture).

**Interfaces:** POST `/api/tasks` accepts `type: research|creative|debate|data`, default `research`; GET task objects expose `type`, and readiness checks expose `na`.

- [ ] Add a browser fixture with mocked login, task detail, and task creation. Assert the form defaults to research, choosing debate sends `type: "debate"`, creative tasks have a visible type label and a usable ready action, and `na` checks say “不适用”. Include an old task without type.
- [ ] Run the browser fixture against current code; expect type selection and display assertions to fail.
- [ ] Add the four-option task type select, pass its value on creation, show type in list and detail, and render `na` checks as not applicable.
- [ ] Run the fixture; expect the task-type assertions to pass.

### Task 2: Link cards on the board

**Files:** Modify `web/app.js`, `web/style.css`, `test/board-ui.playwright.js`.

**Interfaces:** GET `/api/link-preview?url=<encoded>` returns `{ok, url, title, description, domain}`; no authentication data goes in the URL besides the target link. All content is inserted with `textContent` and external anchors use `rel="noopener noreferrer"`.

- [ ] Extend the browser fixture to assert that result and discussion URLs render as cards after preview success; multiple URLs and links in evidence remain separate; preview error returns a plain link; unsafe content cannot insert HTML.
- [ ] Run the fixture against current code; expect link-card assertions to fail.
- [ ] Add URL tokenization, safe link markup, authenticated preview calls with reuse of in-flight results, and card styles. Preserve normal text and fallback links.
- [ ] Run the fixture, existing board/API tests, and Wrangler dry-run; expect all to pass.

### Release: Deploy the front end

- [ ] Compare the branch to current GitHub main, synchronize without losing concurrent backend changes, and push the tested front-end changes to the public repository.
- [ ] Deploy `wrangler.board.toml` through cfcm `a4a41234`.
- [ ] Verify the live board serves the new assets and still returns 401 for unauthenticated `/api/tasks`.
