# Task Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn task replies into a readable conversation and identify the Agent or member referenced by each reply.

**Architecture:** Build one chronological conversation from the existing debate, challenge and supplement arrays. Resolve `reply_to` only against debate messages for the same task, render the quoted author and excerpt safely, and use the existing debate POST when the user selects a reply target. This is a board-only change.

**Tech Stack:** Browser JavaScript, CSS, Playwright CLI fixture, Cloudflare Worker static assets.

**Spec:** `docs/superpowers/specs/2026-11-16-task-conversation.md`

## Global Constraints

- Keep D1, the API Worker, credentials, and the task/debate API unchanged; deploy the board Worker using account `a4a41234`.
- Render externally supplied names and message text using text nodes, keeping existing URL previews and safe external links.
- Reply attribution uses only debate messages in the current task; an absent target gets a neutral fallback.
- Preserve the admin/publisher-only browser composer and the existing `reply_to` POST field.

## Review Focus

- An orphaned or malformed `reply_to` displays an unavailable reference instead of another Agent's name; the browser fixture covers both.
- The same numeric ID in a challenge and debate message never hijacks the reply anchor; the fixture asserts the target is the debate entry.
- Long names, URLs and HTML-like text wrap and remain inert; the fixture checks safe nodes and narrow viewport width.
- Missing or invalid timestamps still produce a deterministic conversation order; the fixture tests an untimed message.
- A viewer cannot access a reply composer or reply buttons; the fixture checks viewer mode.

---

### Task 1: Render the task conversation

**Files:** Modify `web/app.js` (`selectTask`, a new conversation renderer), `web/style.css`; create `test/task-conversation.playwright.js`.

**Interfaces:** Consume the existing task detail response `{debate, challenges, supplements}`. Produce message elements `.conversation-message`, `data-debate-id` only for debate messages, and a quoted reference `.reply-reference` pointing to `#debate-{id}`; provide `renderTaskConversation(data, onReply = null)` for Task 2.

- [ ] Add a browser fixture with interleaved timestamps, replies, an orphan target, a duplicate ID across message types, a missing timestamp, markup in a name/body, source links, and a narrow viewport. Assert chronological order, speaker/type labels, referenced Agent and excerpt, safe text and no overflow.
- [ ] Run the fixture against the current UI; confirm that conversation rendering fails.
- [ ] Implement the conversation renderer and scoped CSS; preserve safe `linkedText` previews and the current empty state.
- [ ] Run the new fixture and existing board UI fixture, then commit the independently readable view.

### Task 2: Reply from the conversation

**Files:** Modify `web/app.js` (`debateForm` and conversation buttons), `web/style.css`, and the conversation browser fixture.

**Interfaces:** Extend `renderTaskConversation(data, onReply = null)` with an optional click handler for debate replies. The composer selects the existing `reply_to` option and sends its numeric ID in `POST /api/tasks/:id/debate`.

- [ ] Extend the fixture to check the quoted target preview when selecting from the dropdown or clicking an inline reply button, the posted `reply_to` ID, refreshed response attribution, and viewer mode with no composer.
- [ ] Run the extended fixture against Task 1; confirm that the reply interaction fails.
- [ ] Implement the inline reply action, accessible target preview, and composer styling; keep the old stance and evidence fields.
- [ ] Run both browser fixtures, the account fixture, Node tests, and board Wrangler dry run, then commit.

### Release

- [ ] Review the full diff and recheck GitHub `main`; integrate any concurrent changes before publishing.
- [ ] Push to `main` and deploy the board Worker using the existing account `a4a41234`.
- [ ] Check the live asset hashes, task 5, unauthenticated API responses, and clean Git status.
