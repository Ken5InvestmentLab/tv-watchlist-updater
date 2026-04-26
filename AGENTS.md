# Repository Guidance

## Commands

- Run the updater with `npm run update` after required environment variables are set.
- Capture a new TradingView browser session interactively with `node save-storage-state.js`.
- There are no dedicated tests or linters; use `node --check update-watchlist.js` for syntax checks when touching the script.

## Project Shape

- `update-watchlist.js` is the main Playwright automation entrypoint.
- The script deletes managed alerts, deletes managed watchlists, imports watchlists, then creates watchlist alerts.
- Managed watchlists use `{prefix}_{YYYYMMDD_HHmm}` in JST, with default prefixes `wl1` and `wl2`.

## GitHub Actions

- `update-tradingview.yml` is the main workflow and uploads debug screenshots from `tmp/**/*.png` as artifact `tv-debug`.
- `autofix.yml` runs after failed main workflow runs, creates one open `auto-fix-needed` issue, and saves screenshots to `debug/screenshots`.
- `auto-fix-pr-trigger.yml` runs diagnostics for auto-fix PRs; keep downstream steps gated when no linked issue is found or the retry cap is reached because `exit 0` only ends the current step.
- Do not add `openai/codex-action`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` to GitHub Actions for auto-repair. Auto-repair is handled by the Codex app automation that checks issues every 30 minutes.
- GitHub Actions should only prepare failure context for Codex: issue body, run URL, commit SHA, branch, and screenshot branch.
- Codex app automation reads GitHub repository variable `AUTOFIX_AUTO_MERGE` before acting.
- If `AUTOFIX_AUTO_MERGE` is exactly `true`, Codex may repair, push a branch, open/update a PR, verify, merge the PR, close the linked issue, and re-run the main workflow on `main`.
- If `AUTOFIX_AUTO_MERGE` is unset or not exactly `true`, Codex may repair, push a branch, and open/update a PR, but must leave the PR open for review and must not merge, close the issue, or re-run the main workflow as a completion step.
- Use `[codex-auto-fix-attempt]` comments for retry tracking in Codex-managed repairs.

## TradingView UI Notes

- In the "Open list" dialog, target rows with `div[data-role="list-item"][data-title]`; plain `div[data-role="list-item"]` also matches sidebar ticker rows.
- TradingView hides the delete button for the active watchlist; switch to a non-managed watchlist before deleting managed lists.
- `openWatchlistMenuHard` intentionally retries multiple menu-opening strategies because the TradingView menu is fragile.
- After deleting alerts, allow time for alert slots to be released before creating new alerts.
- Handle the "One alert to track an entire watchlist" promo dialog before continuing interactions.

## Scope

- Prefer small, durable Playwright selector and state-handling fixes.
- Do not change secrets, credentials, account settings, or destructive production behavior in auto-fix work.
