# Changelog

## Unreleased

- Added a respect-pasted-plan clause to Phase 1 in `src/planner.ts`: when a user supplies a concrete plan or asks to skip brainstorming, the planner flags concrete risks or gaps and asks one confirmation question (`Draft as-is` vs `Adjust plan`) instead of inventing competing approaches.

## 1.0.0 (2026-11-27)

- Fail fast in `/relay` (`src/planner.ts`) before creating a draft record, switching models, or prompting when required worker roles (`builder`, `reviewer`) are not configured, pointing the user to `/relay-configure`.
- Documented the no-default-models behavior, up-front `builder`/`reviewer` check, and optional `planner`/`explorer` fallbacks in `README.md`.

## 0.3.0 (2026-11-26)

- Add `brainstormFirst` configuration option (default `true`) to `src/config.ts`, `src/rpc.ts`, `src/server.ts`, and `src/planner.ts`. When enabled, `/relay` leads with an explicit two-phase prompt (**Phase 1: Brainstorm first**, blocking `relay_plan_add` / `relay_plan_submit` until the planner explores read-only, presents 2-3 approaches with tradeoffs, risks, and non-goals, and aligns via `question`; **Phase 2: Draft and submit** only after the user confirms direction, or `relay_plan_cancel` if abandoned). Expose the toggle in `/relay-configure` (10 batched questions: 4 jobs + 6 settings), `relay_config_set`, `validateConfig`, and `configSummary` (`brainstorm on|off`).
- Standardize `README.md` to match sibling OpenCode plugins: unscoped `# opencode-relay-orchestration` title, Desktop and TUI preview screenshots (`assets/screenshot.png` and `assets/screenshot-tui.png`, included in `package.json` `"files"`), OpenCode Desktop Support section, Problem -> Solution Background, 2-column Features table, OpenCode V2 `"plugins"` manual configuration, Commands & Keyboard Shortcuts tables, numbered Architecture & Internals deep dive (with Agent Tools and Token Usage Breakdown tables), Directory & Storage Structure, and 4-column Configuration Options table.

## 0.2.1 (2026-11-24)

- Redesign Desktop GUI (`src/gui.tsx`, `src/gui.css`) with native OpenCode theme tokens, clearer hierarchy (active record hero, Tasks, Verification, Approvals, Audit, New record, and compact bottom Role configuration grid), semantic status pills/cards, 3-line expandable clamp for long task prompts, inline `Validate config` confirmation feedback, and proportional form/select grids across 280px to 1280px widths.
- Redesign TUI panel (`src/tui.ts`) using structured OpenTUI `box`/`scrollbox` layouts, live `ctx.theme` tokens (`background`, `border`, `text.base/muted/faint/action/feedback`), semantic bordered cards for hero, tasks, verification evidence, and approvals, clipped task prompts/summaries, and compact single-line-per-role configuration rows at the bottom. Remove duplicate background `checkConfig()` calls on mount/session change so transient server reloads never pop unsolicited error toasts, and add regression tests in `test/tui.test.ts`.
- Release audit cleanup: deduplicate `promptTitle` in `src/server.ts` by reusing `cleanTitle` from `src/orchestrator.ts`, remove unused `configText` from `src/config.ts`, remove one-off dev probe migration code from `src/server.ts`, neutralize Windows test fixture paths, and add public npm/GitHub metadata plus `.gitignore`/`.npmignore`.

## 0.2.0 (2026-11-24)

- M7.4: bump package version to `0.2.0`, rewrite `README.md` for the complete v0.2.0 workflow, cut dated release notes, and verify clean `npm pack --dry-run` tarball contents.

- M7.3: add optional per-task builder file-scope gate (`allowedPaths`) with pure repo-relative/glob validation and matching in `src/scope.ts`, enforced structurally via `ctx.permission.hook('evaluate')` for `edit`/`write`/`patch`/`apply_patch`/`multiedit` (plus builder/reviewer prompt guidance and GUI/TUI/planner/report visibility).

- M7.2: add optional verification check scope (`scope: 'task' | 'final'`) so record-level final-gate checks defer until the final task review without splitting UI edits from tests, serialize parallel final reviews to avoid check skips, and enforce freshness against every task's latest build at sign-off.

- M7.1: fix closing HTML/XML tag path-redaction false positive (`</footer>`) in `src/report.ts` while keeping delimited paths redacted, shorten repeated task titles in Evidence and Reviews sections, and enforce explicit screenshot count and total-byte caps (`MAX_SCREENSHOT_COUNT = 8`, `MAX_SCREENSHOT_BYTES = 12 MiB` per check; `MAX_REVIEW_SCREENSHOTS = 12`, `MAX_REVIEW_SCREENSHOT_BYTES = 16 MiB` per review).

- M6.5: live Desktop e2e verified batched 9-question `/relay-configure` saved to plugin storage, completed `/relay` flow (planner switch/restore + token delta, live `relay_explore`, build, review inspecting 1280px and 390px screenshots, user-confirmed Allow, Sign off, Audit panel and Markdown export), live M6.3 width-gate/self-check escalation, and live `relay_plan_cancel`.

- Planner prompt: instruct the planner to use the `question` tool when requirements, scope, or acceptance criteria are ambiguous, conflicting, or high-risk before submitting, and note that Relay runs every verification check and reviewer width check after each individual task so tasks stay self-contained without splitting UI edits from their required test/screenshot updates.

- Pre-M6.5: use one model list with image capability labels and batch all nine `/relay-configure` questions in one question-tool call.

- M6.4 review fix cycle 2: redact file URLs, doubled drive slashes, UNC and home paths while preserving HTTP(S) and safe relative text; log report write failures server-side and label the unverified TUI export capture explicitly.

- M6.4 review fix cycle 1: redact delimited absolute paths while preserving URLs, improve report task/attempt/evidence context, return readable write errors, clarify current-record actions and add populated Audit verification.

- M6.4: add related-record Audit summaries, pure escaped Markdown reports, GUI save/copy feedback and explicit TUI audit/export commands writing only the validated report filename.

- M6.3 review fix cycle 1: cap cancellation reason tool input at 500 characters and document self-check counts as latest-report, prompt-dependent claims.

- M6.3: require effective explorer/viewport planning rules and reviewer width findings, add draft-only reasoned cancellation through shared withdrawal/restoration/lock cleanup, and expose failed builder self-check counts.

- M6.2 review fix cycle 2: persist lockdown ownership only after successful acquisition, clear failed ownership for retries, preserve subsequently added user denies, and clarify settings-dependent plan submission.

- M6.2 review fix cycle 1: isolate lockdown failures, preserve current user rules on release, reconcile terminal locks, validate option settings and enabled models, clarify manual start/effective roles, stamp saves after approval and return readable permission denials.

- M6.2: add fact-filtered `/relay-configure`, permission-gated saved configuration overlays, live model/limit reads, configurable auto-start, shared configuration summary and invoking-session shell self-reply lockdown.

- M6.1 review fix cycle 1: skip switches without an explicit session model, restore after prompt failure, show unavailable terminal/decreased token totals, and cover concurrent restoration, capture timeout and legacy GUI rendering.

- M6.1: replace the failed agent spike/fallback with temporary session model switching to the planner role. Restore once on submission or terminal closure, restore after failed draft creation, and log non-fatal host failures. Track optional primary-session token deltas separately from worker totals in GUI/TUI without changing legacy records or the schema version.

- M5.4: live end-to-end `/relay` run in Desktop (records `ecf41255`, `49702773`) completed plan approval (host prompt, `permission-assert`), build, Playwright check, review with exact screenshot inspection and user sign-off (per user report). Gaps for M6 recorded in M5-REPORT.md (planner model not applied, explorer not exercised live, single-viewport evidence, no planner token delta, no "already done" short-circuit, builder self-check failures not recorded).

- M5.3 review fix cycle 1: interrupt explorers on failed prompt/wait/context/token retrieval, clean reviewer attachment tracking on every settlement/stop/launch failure, and cap inspected names at 300 characters with a run-aware max(50, required attachment count) entry limit. Add failure, legacy-view, builder-rejection and 51-attachment regressions; defer unbounded attachment count and explorer concurrency to M6.

- M5.3: add optional explorer model and read-only relay_explore with child-session guards, explicit permission denials, 10-minute timeout/abort interruption, capped final text and token usage. Require complete exact-name screenshot inspection acknowledgments before review completion; retain legacy report reads and explain incomplete inspection in GUI/TUI.

- M5.2 review fix cycle 1: preserve full task text in planner instructions, select the newest active session record, explain invalid/duplicate/limited check and task inputs, and retain approved outcomes when automatic start fails. Add focused regressions and clarify user-confirmed live approval and planner trust boundaries.

- M5.2: add `/relay` with explicit planner prompt delivery, session-bound draft creation, duplicate-active-record rejection, relay_plan_add/relay_plan_submit/relay_status tools, and approved-only automatic start through the orchestrator. Add structural worker/probe guards and planner-tool permission denials. Spike proves callbacks do not forward the prompt automatically and session.prompt starts a turn. Live human approval through the host prompt launched the read-only task via approved-only autoStart; user confirmed clicking Allow. Test record cancelled, no agent Allow or sign-off. Live withdrawal was covered by M5.1, not repeated here.

- M5.1 review fix cycle 2: block every RPC mutation except withdraw-first cancel while plan approval is pending, including owner/status edits; preserve orchestrator-internal store writes and restore RPC edits after withdrawal.

- M5.1 review fix cycle 1: enforce withdrawal guards inside serialized approval/sign-off/manual writes and before opening prompts; token-guard approved outcomes. Block plan edits during pending approval, withdraw before cancel, preserve request-key revision, and show a sanitized named-check recovery error. Add queued-Allow, pre-prompt, late-rejection, pending-edit/cancel and old-revision regressions; document the cross-platform exit fallback.

- M5.1 live follow-up: verify CLI approval returns pending in 145.093 ms, host permission listing includes the plugin prompt, TUI withdrawal removes it without approving, and cancel the test record. Replace the failed TUI capture with command/result evidence; saved permissions and protected record hash remain unchanged.

- M5.1: non-blocking plan approval with token-bound withdrawal, GUI withdrawal action and `/relay-withdraw`; ignore late Allow after withdrawal and reject matching host prompts best-effort. Re-validate legacy checks, reject control/format characters in reason and screenshot directory, accept a validated session for unbound manual verification, and harden non-Windows process-tree termination plus exit/close fallback. Add regression tests and M5.1 verification evidence.

- M4 review fix cycle 3: reject invisible control/format characters in new check names and commands, preserve complete visible command display, and separate the 160-character addCheck input schema from the legacy-compatible 1000-character record output schema. Add store and RPC schema regressions.

- M4 review fix cycle 2: limit check commands to 160 characters in storage, RPC and GUI input, and show listed commands in full in approval metadata/messages and TUI status. Add exact 160/161 boundary and full-command visibility regressions; amend the contract and verification documentation.

- M4 review fix cycle 1: expose approved check commands/counts, abort running checks on interrupt/cancel, re-hash screenshot bytes before attachment, deny manual-verification authority in both probes, improve manual prompt context and image-recovery guidance, cap/uniquely name checks, shorten evidence titles, hide empty screenshot counts/repeated not-applicable reasons, and scroll/focus GUI errors. Add regression tests and affected M4/TUI captures; document deferred process-close/tree cleanup and unbound manual-session limitations.

- M4 milestone 2: Verification GUI/TUI check controls, evidence labels and permission-gated manual forms; 20 narrow/wide fixture captures and read-inspected live Desktop/TUI evidence. Live missing-Playwright sandbox pauses unverified; web sandbox plugin-run Edge check and screenshot review succeed, awaiting human sign-off. Document the orphaned approval workaround and retained timeout/orphan-cleanup limits.

- M4 Desktop scroll fix: constrain Relay to its host height with vertical scrolling so Tasks and plan approval remain reachable; show the policy without repeating the check name. Add constrained-height smoke assertions at 280/320/480 and preserve existing captures while regenerating M4 evidence.

- M4 milestone 1: schema-v3 draft-only verification checks, build-bound evidence, plugin-run command/Playwright adapter, verification pauses and bounded fix cycles, screenshot review attachments, permission-gated manual verification, evidence-aware sign-off, RPC schemas and shared view helpers. Panels and live verification remain milestone 2 work.

- M3 review fix cycle 3: share the 10-second host-call bound across stop interruption, failed-launch cleanup interruption and end-of-run token lookup. Add fake-timer regressions proving failed launch and missing token responses cannot indefinitely wedge the record queue; preserve existing error log patterns and omit unavailable tokens.

- M3 review fix cycle 2: assert exact worker permission arrays, bound each stop-session interrupt wait to 10 seconds with timer cleanup, cover a never-resolving host interrupt using fake timers, and capture the completed sandbox TUI with corrected owner/finding/ellipsis formatting. No live workers or record mutations.

- M3 review fix cycle 1: share contains-style `*opencode*` shell denial across workers/probes, add probe authority/delegation denies and permission-set tests, assert SDK Tool.Error through registered relay_report, fix singular findings and terminal summary punctuation/owner wrapping, align token fixture fix cycles, and document empirical matcher evidence, human sign-off attribution and interrupt-queue risk.

- M3 milestone 3: live sandbox record completed two build/review tasks using configured builder and reviewer workers, with session permission/report evidence, run tokens/durations and Desktop/TUI captures. Fixed singular builder-check wording and made exhausted-fix fixture show two fix cycles and attempt 3. Sign-off resolved through host permission; exact click attribution remains unverified. No rerun or cleanup performed.

- M3 milestone 2 verified: run-aware GUI/TUI stages, attempts, bounded summaries, findings and self-reported checks, token totals, escalation guidance, running edit locks and sign-off pending/denied feedback. Added relay-signoff, 167 GUI smoke captures, read-only Desktop/TUI evidence and complete screenshot manifest; 74 tests pass.

- M3 ordering fix: listRuns resolves equal startedAt timestamps by attempt, build-before-review stage, then id, keeping orchestrator and panel latest-report selection deterministic. Added an equal-timestamp ordering/latest-report regression.

- M3 milestone 2 work in progress: run-aware shared task stages, attempts, report summaries, findings/check labels and token totals; GUI sign-off pending/denied states and running task locks; TUI relay-signoff and mocked panel coverage. Verification paused on existing M1 same-timestamp run-ordering failure before completion.

- M3 milestone 1: serialized build/review orchestration, project-scoped run audit storage, session-bound relay_report, bounded findings/fix cycles and explicit interruption/resume; worker permission restrictions, token-only run snapshots, listRuns RPC and host-permission sign-off. Manual task edits are rejected while running. Existing Complete controls route through signOff pending milestone 2 panel work.

- GUI startup load retry: the automatic refresh and role validation on mount, session change or reconnect retry after 0.5 s, 1 s and 2 s before showing "Could not refresh" or "Could not validate role configuration". Manual Refresh and Validate config still report immediately. Failures are logged with console.warn including the original error. Pending retries are cancelled on session change or panel close. Smoke adds gui-panel-startup-retry-{recovered,failed}-{280,320,480}.png.

- Post-sign-off Desktop check (docs only): the Relay tab works with the { package, options } entry. Desktop 2.3.2 lists only built-in launchers in the Add tab menu; Relay opens from the command palette ("Relay status") or /relay-status. desktop-m2-b-roles.png captured. No code change.
- Milestone 5 review fix cycle 3: separate unknown-role validation from role parsing to remove a dangling else and duplicate shape errors; add exact mixed-invalid-role and valid-model-plus-unknown-key regressions. Rebuilt GUI bundle is byte-identical.
- Milestone 5 review fix cycle 2: require an exact normalized red probe answer, use invalid_op for concurrent probes, guard legacy cleanup storage failures, reject unknown role keys, gate GUI probing on reviewer validity, separate configuration feedback from record errors, improve TUI probe messages and role identity layout, and correct realistic status/token smoke fixtures.
- Milestone 5 fix cycle 1: log image probe exceptions, return non-cached host errors separately from completed vision answers, remove only the exact known stale exception cache via storage API, add retry/logging regressions and inspect Desktop GUI loader evidence without config edits or probe retries.
- Phase B milestone 5: crypto-free role options parsing, role/model validation and explicit cached image probe RPCs/panel actions; per-record reconciliation continuation and phase-specific approval confirmation. Global options use the supported { package, options } entry. The one live image check failed with zero tokens; final enableProbe omitted.
- Phase B milestone 4 fix cycle 1: isolate crypto-free model code from storage, enforce terminal edit locks/draft-only approval/nonempty completion gates, preserve v2 approval confirmation by plan revision, improve owner and interrupt controls, cap owner sessions, test reconciliation races/error logging and add realistic v2 plus live Desktop/TUI evidence.
- Phase B milestone 4 (B1/B2/B4): schema-v2 read migration, plan-scoped approval, explicit record lifecycle, owned-task scheduling and fix-cycle limits, queued startup interruption, matching GUI/TUI controls and lifecycle commands, expanded regression/smoke and real protected-record/TUI evidence.
- Phase A fix cycle 1: expose normal-action aria-busy and wait cursors without locking approval prompts, expand Unicode prompt sanitization, handle task titles without count/revision metadata, remove the unused GUI error import, separate error banners from adjacent controls, and correct Desktop prompt evidence.
- Phase A milestone 2 (A2/A3/A5): retain action errors across live refreshes with separate reconnect feedback; keep the panel interactive during approval; include sanitized bounded task titles in prompts; follow host appearance with contrasting fallback and disabled palettes; advance stale mock revisions and expand GUI/real Desktop evidence.
- Phase A milestone 1 (A1/A4): normalize string, Error and RPC failures to readable messages with a generic unknown-error fallback; silence and assert expected server fault logs; add sectioned terminal status with ordered counts and a 12-task cap, plus reactive refresh and toast regressions.
- Fix cycle 11, round 2: restrict duplicate-error suppression to requestApproval and matching visible stale/rejected outcomes; preserve stale mutation banners even with an approval result visible, add zero/four-history cap coverage, and qualify historical terminal-only prompt claims.
- Cycle 11 contrast follow-up: use existing host text-strong for primary text and unmixed text-base for secondary text, retaining mocked-host fallbacks. Verify both Desktop themes with non-persistent media emulation, revision-18 approval, single stale outcomes in Desktop/terminal, capped approvals and Desktop-to-terminal live refresh.
- Fix cycle 11: share stale/rejected error suppression after snapshot refresh, cap approval history at three plus earlier count, and derive panel muted/border/control/focus colors from host light/dark tokens.
- Correction to cycle 8's generic-host-rendering claim below: this limitation is terminal-only. Desktop renders the hook message and revision-bound resource. Live Allow always created no saved rows and the next revision prompted again in OpenCode 2.3.2.
- Fix cycle 10: bind pending markers and stale outcome feedback to the current revision, protect original errors during settlement refresh, gate Escape by focused active panel and clear focus on relay-close.
- Key outcome history per record, hide outcome text during current approval waits, remove the agent-added unused terminal wait flag and verify live stale approval and refreshed terminal captures.
- Fix cycle 9: map the real-host Permission.DeclinedError plain rejection to typed approval_denied, publish rejected feedback without changing approvals, add a regression and verify the actual terminal Reject path.
- Fix cycle 8: scope terminal Escape to focused Relay content with pass-through otherwise, suppress old/duplicate result toasts, expire result lines by revision, show pending revision explicitly and disable duplicate desktop approval.
- Check revision before marking a request pending; document generic host permission rendering (terminal only) and unsettled-prompt workaround; add focus, rejected-result and result-line regressions plus six desktop outcome captures.
- Fix cycle 7: add panel-scoped Escape and relay-close recovery, non-focusable terminal content, authoritative host approval settlement after client disconnect and reconnect-visible pending/results.
- Show approval/rejection/stale feedback in terminal toasts and desktop status; add abort/revision/pending regressions and real-terminal focus and recovered-approval evidence.
- Rename to Relay Orchestration: opencode-relay-orchestration package/plugin/RPC identity, relay commands and permission/storage/UI namespaces; leave prior host test data untouched.
- Fix cycle 6: return explicit terminal cleanup, own and dispose the setup watcher, test ownerless setup/disposal, document palette discovery and require the verified registerHooks-compatible Node engine range.
- Fix cycle 5: register terminal commands once from the app slot in global mode, expose all four commands in the palette, retain the status panel/dialog fallback and dispose both slot claims.
- Add a mocked actual-TUI-setup regression for registration, repeat renders, fallback and cleanup; consistently name this plugin's records orchestrator records.
- Rename the uninstalled package and its runtime, permission, storage, UI and command identifiers to OpenCode Orchestrator before the first real-host installation.
- Fix cycle 3: clear record/task drafts on session changes, verify approval deduplication survives abort until the host prompt settles, measure limits after trimming, and align the smoke approval source with permission-assert.
- Add aborted-prompt and trimmed-limit regressions; regenerate and visually inspect all 17 GUI captures.
- Fix cycle 2: isolate pending GUI operations across session switches, validate creation sessions, sanitize Unicode prompt text safely, preserve created probe markers and validate optional variants.
- Add record/task limits, post-prompt abort coverage, real shared-format assertions, visible TUI creation errors, portable smoke browser fallback and pending-status spacing; regenerate and inspect all 17 captures.
- Implement revisioned project-scoped records, a serialized storage queue, closed task mutations and post-persist RPC events.
- Add scoped permission evaluation for explicit revision-bound plan approval and an unprompted pinned-model reviewer compatibility probe.
- Add shared terminal/text/desktop views, explicit commands and snapshot refresh on matching live events and reconnect.
- Add store/server/view tests and built-bundle Playwright evidence at 320 and 480 pixels.
- Document unresolved OpenTUI Node engine compatibility, production dependency audit findings and real-host verification boundaries.
- Scaffold the Milestone 1 package manifest and install the pinned OpenCode 2.3.2 SDK for compatibility inspection.
- Deliver scoped permission-assert approval with record-session validation, sanitized prompts, in-flight deduplication and cancellation checks; preserve unexpected errors as internal failures.
- Harden default-off reviewer probes with parent/model validation; move Solid to peer/development dependencies.
- Repair form success/error handling, pending/disconnected presentation and human-readable dates; add approval validity, pagination, consistency and event-failure tests, plus 17 reviewed GUI captures.
