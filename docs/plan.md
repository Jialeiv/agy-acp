# Open work

Open items only, most consequential first. Each states the problem, the evidence, the options,
the recommended decision and how to accept it. When an item ships, delete it here and record it in
[`CHANGELOG.md`](../CHANGELOG.md). Evidence about sibling bridges is in
[`research/`](research/README.md).

## 2. Bound the ACP stdout reassembly buffer

- Problem: `AcpConnection` appends stdout to an uncapped `stdoutRemainder` and splits on newlines
  (`src/runtime/acp-connection.ts:159,176-177`); a flood without a newline grows memory without
  limit. estebanforge and zacbemis cap a frame at 32 MiB and retire the transport on breach.
- Decision: cap by UTF-8 bytes per line (not string length before splitting); on breach, reject
  pending requests and close the worker as a `502` worker-closed failure. Choose the cap to allow
  large image and tool frames (at least 32 MiB).
- Acceptance: a fake-ACP test streaming an unterminated line past the cap closes the worker with
  a classified failure and does not grow memory beyond the cap; normal large frames still pass.

## 3. Output-cap continuation notice

- Problem: `agy`'s "your previous response was cut off because it exceeded the output token
  limit ... please continue from where you left off" notice (optional `retries remaining: N`)
  reaches the caller as model text; no code path matches it.
- Evidence: fdkevin0 classifies it `drop | hold | emit` across chunks, with an unbounded hold.
- Decision: handle it like the retry notice: newline-complete matching, a bounded hold, and
  stripping only when the turn's own log corroborates it, so a model quoting the notice is
  delivered verbatim.
- Acceptance: `bun test` cases for a split notice, a quoted notice without log evidence, and an
  over-long hold that is released as text.

## 4. Wider secret redaction

- Problem: `redactSecrets` (`src/accounts/env.ts:605`) does not cover `AIza...` API keys,
  `sk-...`, `npm_...`, `gh[opurs]_...` tokens, URL userinfo, `cookie` / `set-cookie` values, or
  JSON `client_secret` / `api_key` keys.
- Decision: add those patterns, keeping the existing bearer, `ya29.`, `1//`, `4/0A`,
  `/mcp/<token>` and OAuth-parameter coverage.
- Acceptance: the existing leak regressions gain one case per new pattern and still pass.

## 5. `Retry-After` for an absolute reset

- Problem: a spent window naming an absolute reset (`reset on Sep 4, 2026 12:30 UTC`) is classified
  `quota` but `retryAfterSecondsFrom` reads only relative waits, so no header is sent
  ([error-routing](error-routing.md#3-spent-quota-versus-transient-limit)).
- Decision: parse `on <Mon D, YYYY HH:MM> UTC`, compute seconds from now, clamp to the existing
  1 s ... 24 h range.
- Acceptance: unit tests for an absolute reset in range, past, and beyond 24 h.

## 6. `agy` binary preflight

- Problem: a stale or wrong `agy` fails deep inside a turn. Only an explicit
  `mcpCapabilities.http: false` is refused at `initialize` (`src/runtime/worker.ts:732-736`); the
  minimum version is declared in the README only.
- Evidence: tianzuo555 classifies `not-found | permission-denied | timeout | spawn-failed |
  invalid-version | unsupported-version` and keys its cache on the resolved path as well as the
  binary's stat signature.
- Decision needed: the minimum supported `agy` version. Then classify preflight failures into
  those six categories, surface them at startup and in the first failing turn as a classified message rather than a generic `500`,
  and include the resolved path in the catalog fingerprint.
- Acceptance: tests with a missing binary, a non-executable file and an old version string each
  yield the matching category without spawning a turn.

## 7. Use JSON-RPC codes in failure text

- Problem: failures are classified from message text only. estebanforge's ACP reference records
  `-32602` with `data.errors[].loc` naming the offending field, `-32000` for server-state
  messages, `-32601` for an unimplemented method.
- Decision: append the JSON-RPC code and any `loc` path to the redacted `Upstream said:` detail of
  `invalid_request`, without changing classification.
- Acceptance: a fake-ACP `-32602` with `loc` produces a `400` whose detail names the field.

## 8. Finish the cloaking scope

- Problem: two scope gaps remain after 0.1.10 closed the other two.
- Evidence: against `packages/agy-cli/cloak.mjs` and `packages/antigravity-cloak/`, the trigger list
  matches line for line. Shipped in 0.1.10: the two Codex lines in **user-authored text**, because
  the middleware measured that "since 11-14 Antigravity also answers a bare 429 to Codex's GPT-5
  line in a user's turn … 3 of 3 on a real account" while the other lines passed there, and a
  `saidAs`-style `phrase=replacement` list (`cloak_said_as`), so an unrecognized phrase no longer
  needs a release.
- Still open:
  1. **Mid-conversation system/developer messages.** `agy-cli` rewrites these; this plugin turns
     them into `<system-reminder>` user text without the rewrite, and only the two Codex lines are
     handled in user text, so a Hermes or RFC 2119 line arriving mid-conversation goes out as
     written. Unobserved either way; the middleware only confirmed the Codex lines in a user turn.
  2. **U+FEFF as a word separator.** Our `SPACE` class excludes the invisible characters because
     including them produced a 12.7 s backtracking blow-up on a long U+FEFF run; the others' `\s+`
     matches them, so a line whose words are separated only by U+FEFF is rewritten by them and
     missed here. Any fix has to be a bounded run plus a timing test, not `\s`.
- Decision: open, both low priority (cloaking is on by default since 0.1.11, so a miss now
  costs the request).
- Acceptance: a test that the phrase is rewritten in the scope it was added for and left alone
  everywhere else; for (2), a `bun test` timing check with a 3,200-character U+FEFF run.

## 8b. Findings from the 0.1.10 review left open

- Problem: two defects from the review are still open; the usage double count and the reused
  prompt after a local timeout are fixed in 0.1.10.
- Evidence: the `gpt-6-astra` and `deepseek-flash` passes over `v0.1.9..HEAD`, 2026-11-14.
  - `bankSuppressedPromptTurn` still divides the old way and ignores `turnReported`, so a
    suppressed turn that already reported a batch banks too much. Reusing
    `settlePromptTurnFromAcp` for the ACP case is the fix; a test needs a steering cancel that
    carries a prompt result.
  - A caller tool named `await_result` is shadowed by the relay tool; the internal name is not
    reserved in `src/mcp/schema/sanitizer.ts`. Either reserve the name (renaming the caller's tool
    is a visible change to their MCP catalog) or skip the relay for that session and say so.
- Also unverified: whether `session/prompt`'s `usage` includes the tokens of tool steps. The ACP
  path subtracts what batches reported (`src/usage/tracker.ts`), which is only right if it does;
  one probe with a tool call settles it.
- Decision: fix in that order, each with a reproduction.
- Acceptance: a test per defect that fails before the fix.

## 9. A session key when the host names no session

- Problem: `sessionId` comes from `x-agy-session-id` or `x-magpie-session` and nowhere else
  (`src/protocol/anthropic.ts:958-960`). A client that sends neither is stateless here
  (`src/sessions/coordinator.ts:339-341`), so every turn re-renders the whole history and no
  prefix is reused. Correction: behind Magpie this is rare — the host derives a conversation id
  and passes it to the plugin (`gateway.go:6399`, `plugins.go:794-796`, `host.js:3500-3506`),
  which `src/index.ts:416-417` copies into `x-agy-session-id`. The gap is a client that talks to
  the plugin without the host in front of it, so this item is smaller than it first read.
- Evidence it can be derived: `magpie-community/antigravity` (0.1.14) hashes the session, the
  subagent and the conversation's first *real* user turn, skipping injected preambles
  (`INJECTED_USER_TEXT`: `# AGENTS.md`, `<environment_context>`, `<system-reminder>`,
  `<permissions instructions>`, `{"page_id"` snapshots, subagent notifications), and ignores a
  session id shaped like a per-request one (`^magpie-[0-9a-f]{24}$`).
- Fix: derive the same way, with the work directory and subagent in the hash so two conversations
  that open with the same prompt do not share a ledger. It must be a *stable* derivation: a wrong
  collision merges two conversations' shelves, which is worse than no reuse.
- Acceptance: with no session header, two turns of one conversation reuse the worker and the
  second prompt is a prefix continuation; two conversations with an identical first prompt get
  different session keys; a request with no user text at all stays stateless.

## 10. Decisions not yet made

Each needs a decision before any code; none is scheduled.

- `application/pdf` documents: `agy 1.5.8` advertises `promptCapabilities.embeddedContext: true`,
  but native handling of a `resource` (`blob` + `mimeType: "application/pdf"`) is unverified, so
  `src/protocol/anthropic.ts` rejects binary PDF document blocks with `400`. Decide after an
  end-to-end probe.
- Structured output: keep prompt-level `output_config.format` / `response_format`, or add a
  virtual `StructuredOutput` MCP tool with a retry loop and streaming `<tool_call>` text
  interception as Magpie's Claude bridge does (`claude_tui_schema.go`, `claude_text_calls.go`).
- Awaiting-tool retirement: the scheduler retires an `AWAITING_TOOL_RESULTS` worker after ten
  minutes (`src/runtime/scheduler.ts`), while the worker's tool-idle budget is sixty. With the
  170-second bound above, a long tool no longer waits inside a parked call, so decide whether ten
  minutes is the intended ceiling for the caller's own tool execution or whether it should match
  the tool budget. Either way the retirement has to reach the replay path, not an empty answer.
- Warm-session identity: keep tolerant `tool_use.input` prefix matching
  (`src/sessions/ledger.ts:272-276`) or require an exact count + prefix fingerprint + expected
  assistant fingerprint (zacbemis).
- Schema projection: whole-tool omission with validation against the original schema (zacbemis)
  versus the current lowering to `agy`'s narrower translator; needs a validator choice and a
  tool-loss policy.
- Credential storage: `AGY_ACP_FORCE_FILE_STORAGE` in place of the `SSH_CONNECTION` marker,
  only if the `agy` CLI is shown to honor it.
- Per-session Bearer header in addition to the URL token, only if URL exposure becomes a concrete
  threat.
- Not yet evaluated against this plugin: selector read-back and permission-mode drift checks
  (zacbemis); "status OK with no model output" as a failure, `<SYSTEM_MESSAGE>` echo stripping,
  and strip-and-reparse of known noise lines (estebanforge).

## 11. From the 2026-11-15 comparison (not yet started)

Each item names the sibling, its commit and what would make it done here. Nothing in this list is
implemented; §8b, §9 and §10 are the older open work.

- **MCP image results are offloaded by `agy`** (`magpie-community/plugins` `6e0cecb`, 2026-11-14;
  `packages/agy-cli`): a tool result carrying an image came back to the model as `media_0.jpg`,
  invisible, and the agent re-read it 8 times; their fix text-acks the MCP call, waits for the tool
  commit, steers, and puts the image in the next prompt. Ours hands the image to MCP as it is
  (`src/mcp/broker.ts:165-174`). Done when a screenshot result is read once and the model names
  what it saw, with the relay and usage settlement unchanged.
- **A session opened before a prompt was reworded is resumed anyway** (`1c3c58b`, `fc941f6`):
  they hash the *outgoing* instructions and keep a user-cloak epoch, so a session holding the old
  text is not reused. We compare the client's original text (`src/sessions/shelf-store.ts:994`,
  `src/sessions/coordinator.ts:480-503`) and send the transformed text separately
  (`src/runtime/worker.ts:775-782`). Done when flipping `cloak_prompts` or changing
  `cloak_said_as` forces one cold start instead of a resume that still carries the old append.
- **The always-loaded tool catalog has no aggregate budget** (`6646797`, `9126c46`): they fit it to
  18k estimated tokens of a 20k shared CLI budget, keeping names, types, enums, required and
  bounds. Our 256 KiB/8192-node limits are per-schema translation guards
  (`src/mcp/schema/sanitizer.ts:50-55`). Done when a 130-tool catalog still reaches `agy` whole, or
  says what it dropped.
- **One structured row per native-session decision** (`1a08f08`): a conversation digest, a reason
  (`no_live`, workdir, instructions, history, cloak epoch) and counts, rate-limited, no prompt
  text. Ours has the reasons but writes none of them. Done when a cache-miss incident is readable
  from the log without the transcript.
- **Compaction intent is recognised loosely** (`DylanLIiii/opencode-antigravity-bridge` `d032a43`,
  `84ffd25`): ours trims the middle of an oversized turn whenever `<conversation>` appears anywhere
  in it (`src/sessions/prompt-render.ts:420-459`), which any XML discussion satisfies; they match
  the stock prompt by hash and refuse a compaction request that cannot fit rather than invite
  another compaction. Done when a quoted `<conversation>` sample is not treated as a compaction
  request.
- **A relayed call may complete without its result** (`fdkevin0/pi-agy-acp` `d64a548`): they hold
  the answer while any relayed id is unretrieved and refuse a premature `end_turn`. We shelve a
  result when nobody waits (`src/mcp/broker.ts:294-300`) and can continue after the native prompt
  ended (`src/runtime/worker.ts:2034-2055`), which is a fallback, not a gate. Done when a turn
  cannot finish on an answer written before a relayed result was delivered — keeping our
  continuation, and without their silent 65,536-character truncation.
- **`error: null` is read as success** (`d64a548`): `src/runtime/acp-connection.ts:242-257`.
  Done when a malformed error envelope fails the request instead of resolving `undefined`.
- **An empty `200` is retryable again** (host `c0cf352a8`, 2026-11-15): Magpie now turns a
  reply that carries neither content nor a finished stream into a `502` when a group has another
  member, so the cancelled non-streaming answer this plugin still returns as `200 end_turn`
  becomes a walk to another account — the stop that does not stop, one layer up from our status
  choices. Done when a cancelled non-streaming request answers a status Magpie does not read as
  "another member may do better".
- **Only real billing metadata is deleted** (`DylanLIiii` `b2baef1`): our
  `stripBillingHeader` deletes any line starting with the header, inside a fenced example too, and
  does so with cloaking off (`src/protocol/cloak.ts:119-127`). Done when a quoted example keeps its
  line and the cache-stability reason for deleting the real one is still met.

## Optional refinements

- Restructure `docs/claude-bridge-parity.md` around a capability matrix (one row per capability,
  one column per bridge), in the manner of estebanforge's `docs/ENGINES.md`.
