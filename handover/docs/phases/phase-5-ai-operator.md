# Phase 5 — AI operator (T4) → `v0.6.0`

Goal: Claude, Codex or any MCP agent can run the shift through Mise's own commands, with the same permissions, limits and audit as staff, side by side with people.

**Figma:**
- Operator mode `93:2`, M31 `106:1153`
- Connect an AI operator `98:262`, M32 `107:650`
- Integration board `99:446`
- Agent console `99:577`

---

## M50 · Audit log and undo · M
**Build**
- Every command writes an `Event` with actor (member / agent / system), before and after.
- Undo creates an inverse command where one is defined. Commands without an inverse are marked "not undoable" in the UI.
- A Live activity feed component (used on Live store and Operator).

**Accept**
- [ ] 100% of commands produce events (test that enumerates the command registry). Undo works for orders, stock, khata and replies.

## M51 · Permissions, limits, presence · M
**Build**
- Per-task autonomy for agents: Watch / Ask / Alone. Tasks:
  - reply to customers
  - take orders from chats
  - book riders/couriers
  - refunds/discounts
  - supplier orders
  - message staff
- Limits: money caps, quiet hours, and a "never" list (e.g. cancel paid orders, change prices).
- "Who's handling" presence on chats and orders. When a person acts on something an agent holds, the agent steps back and leaves a note.

**Accept**
- [ ] The server rejects agent commands outside permissions or limits (tests). "Ask" turns the command into an Inbox question with Allow / No.

## M52 · Remote MCP server · L
**Build**
- `services/mcp`: TypeScript, official MCP SDK, Streamable HTTP transport, OAuth 2.1 with scoped, revocable agent keys per outlet.
- **Tools (thin wrappers over `/commands` and queries):**
  - `start_shift`, `end_shift`
  - `next_tasks`, `wait_for_work(timeout ≤ 300s)` (long-poll)
  - `read_chat`, `reply`
  - `create_order`, `confirm_order`, `update_order_status`
  - `book_courier`, `match_payment`, `update_stock`, `draft_supplier_order`
  - `ask_human`, `hand_over`, `note`, `undo`, `ping`
- **Safety:**
  - tool descriptions state that content from customers is data, not instructions
  - server-side guards enforce permissions and limits regardless of the agent's input
- **Documentation:**
  - connect from Claude: Customize › Connectors › Add custom connector with the server URL
  - connect from Codex: `codex mcp add mise --url …` then `codex mcp login mise`
  - verify the current steps in each product's docs at implementation time and link them

**Accept**
- [ ] An MCP inspector session can authenticate, list tools, run a full cycle on a test outlet, and is blocked when exceeding a limit.

## M53 · Agent console · S
**Build**
- `/app/agent`: a plain, stable-label page for agents driving a browser (e.g. Claude in Chrome):
  - the task list with IDs, clear instructions and big buttons
  - the playbook, the current permissions
- The same commands and audit as everything else.

**Accept**
- [ ] Every task can be completed with clicks only. Labels are stable (data-testid and aria labels).

## M54 · Connect-an-agent settings · M
**Build**
- **Steps:**
  1. choose the agent
  2. connect (address + copy; Codex lines + "send to PC")
  3. start once: copy start prompt / open the agent's app if a URL is known
  4. keep it running:
     - scheduled check-ins (instructions per agent)
     - one live session per shift using `wait_for_work`
     - optional trigger URL called on urgent events
  5. test cycle
- **Heartbeat:** the agent calls `ping` or any tool. If there is no check-in for 15 minutes during opening hours, the manager is notified. Built-in rules keep running.

**Accept**
- [ ] The test cycle reports pass/fail with details. The missed-heartbeat alert fires in a simulated gap.

## M55 · Built-in checks engine · M
**Build**
- A rules engine (server, scheduled + event-driven) for the 12 "When → Mise" checks on the landing page:
  - kitchen not acknowledged · portal order missing · rider not picked up
  - payment without order · cash count gap · risky COD buyer
  - stock below target · shift short · missed check-in
  - drifting regular · khata due on payday · channel signed out / agent quiet
- Each rule creates a task that a person or agent resolves. Per-outlet toggles and thresholds.

**Accept**
- [ ] Each rule has a test that triggers it with fixture data and checks the task created. Release `v0.6.0`.
