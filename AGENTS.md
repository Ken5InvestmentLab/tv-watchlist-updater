# Repository Guidance

## Commands

- Run the updater with `npm run update` after required environment variables are set.
- Capture a new TradingView browser session interactively with `node save-storage-state.js`.
- Run `npm test` for alert-webhook regression checks and `node --check update-watchlist.js` for syntax checks when touching the updater.

## Project Shape

- `update-watchlist.js` is the main Playwright automation entrypoint.
- The script deletes managed alerts, imports and protects one replacement anchor, deletes old managed watchlists, imports any remaining replacements, then creates watchlist alerts.
- Managed watchlists use `{prefix}_{YYYYMMDD_HHmm}` in JST, with default prefixes `wl1` and `wl2`.

## GitHub Actions

- `update-tradingview.yml` is the main workflow and uploads debug screenshots from `tmp/**/*.png` as artifact `tv-debug`.
- The main workflow runs on the local `self-hosted`, `Windows`, `tv-watchlist` runner and connects only to the loopback Edge CDP endpoint for the user's normal Edge `Default` profile. Do not move it back to a hosted runner: it cannot use the interactive TradingView session.
- In CDP mode, create an updater-owned tab and never close or navigate the user-visible Edge window. The ignored `.local-runner/` directory and the Edge profile are local operational state, not repository artifacts.
- `autofix.yml` runs after failed main workflow runs, creates one open `auto-fix-needed` issue, and saves screenshots to `debug/screenshots`.
- `auto-fix-pr-trigger.yml` runs diagnostics for auto-fix PRs; keep downstream steps gated when no linked issue is found or the retry cap is reached because `exit 0` only ends the current step.
- Do not add `openai/codex-action`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` to GitHub Actions for auto-repair. Auto-repair is handled by the Codex app automation that checks issues every 30 minutes.
- GitHub Actions should only prepare failure context for Codex: issue body, run URL, commit SHA, branch, and screenshot branch.
- Codex app automation reads GitHub repository variable `AUTOFIX_AUTO_MERGE` before acting.
- Codex app auto-fix monitoring should not stop for human approval prompts; use non-approval paths such as available GitHub connector APIs and local sandboxed commands, and record a blocker instead of prompting when auth or permission is unavailable.
- If `AUTOFIX_AUTO_MERGE` is exactly `true`, Codex may repair, push a branch, open/update a PR, verify, merge the PR, close the linked issue, and re-run the main workflow on `main`.
- If `AUTOFIX_AUTO_MERGE` is unset or not exactly `true`, Codex may repair, push a branch, and open/update a PR, but must leave the PR open for review and must not merge, close the issue, or re-run the main workflow as a completion step.
- Use `[codex-auto-fix-attempt]` comments for retry tracking in Codex-managed repairs.

## TradingView UI Notes

- In the "Open list" dialog, target rows with `div[data-role="list-item"][data-title]`; plain `div[data-role="list-item"]` also matches sidebar ticker rows.
- TradingView hides the delete button for the active watchlist; switch to a non-managed watchlist before deleting managed lists.
- TradingView also hides deletion for the last created watchlist; built-in flagged lists such as `Red list` do not count, so import and protect one replacement anchor before deleting all old managed lists.
- `openWatchlistMenuHard` intentionally retries multiple menu-opening strategies because the TradingView menu is fragile.
- Before opening the watchlist menu, ensure the watchlist side panel is open and avoid using broad Watchlist aria/text selectors as the menu button; those can match the right-sidebar panel toggle.
- When `#overlap-manager-root` intercepts clicks, clear blocking overlays/dialogs before retrying the target button; prefer short click timeouts plus fallback strategies over adding long sleeps.
- If TradingView shows a "Session disconnected" dialog because the account was accessed from another browser or device, click `Connect` to reclaim the updater session, but cap reconnect retries to avoid an endless loop if another device keeps taking over.
- After deleting alerts, allow time for alert slots to be released before creating new alerts.
- Handle the "One alert to track an entire watchlist" promo dialog before continuing interactions.
- TradingView Premium watchlists are capped at 500 symbols per list; the builder must generate files within that limit. The updater must fail with a clear error instead of trimming symbols silently.
- Before submitting a watchlist alert, verify that the alert condition dialog shows the configured `ALERT_CONDITION_NAME`; do not submit the default Price/Moving Up condition as a fallback.
- Require `TRADINGVIEW_ALERT_WEBHOOK_URL` before deleting existing alerts/watchlists. Configure Webhook explicitly for every new alert and reopen the notification form to verify the enabled checkbox and exact URL before submitting; do not rely on TradingView remembering notification defaults. Keep the URL out of logs and committed files.

## Scope

- Prefer small, durable Playwright selector and state-handling fixes.
- Do not change secrets, credentials, account settings, or destructive production behavior in auto-fix work.
