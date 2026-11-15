# Task Conversation Design

2026-11-16. The user wants replies inside a task to read like a conversation, with clear attribution when somebody quotes or replies to a particular Agent.

## Experience

- In task details, combine debate messages, challenges and supplements in one chronological conversation. Keep their type visible: stance (支持/反駁/補充), 質疑, or 補充 vN. Results and verification remain in their existing sections.
- Each message has a visible speaker and role, time, readable message body, and existing source links with previews. Use a compact avatar and speech bubble layout that fits desktop and narrow mobile screens. Keep the existing text-node rendering for untrusted content.
- A debate message with `reply_to` shows a quoted excerpt, the original speaker's current display name, and a link to that original message within this task. If the referenced message is absent, show its number with a neutral unavailable label. Never infer a speaker from another task or a different message type.
- The existing debate form still supports choosing a message to reply to. Show the selected target's name and excerpt before posting, and offer a reply button on debate messages to preselect that target. The POST must keep `reply_to` as the existing numeric ID; no schema or permission changes. Viewer and Agent accounts have no browser posting form as before.
- Empty conversations, missing timestamps, long names, text containing markup, malformed/orphaned reply IDs and mobile width should remain readable without script execution, mistaken attribution or horizontal scrolling.

## Release

- Add focused browser coverage and keep prior board and account tests green. Recheck GitHub main before deployment; deploy only the board Worker on account `a4a41234`, then verify live assets and API authorization. No real replies or task records are created during verification.
