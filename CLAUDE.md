# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the watchlist updater (requires env vars set)
npm run update

# Capture a new TradingView session token interactively (headful browser)
node save-storage-state.js
# → launches browser, wait for manual login + 2FA, then press Enter → saves storageState.json
```

There are no tests or linters configured.

## Architecture

This repo automates TradingView watchlist management via Playwright (headless Chromium).

### Entry point: `update-watchlist.js`

Single ~2700-line Node.js script. The `main` IIFE at the bottom drives the full flow:

1. **Delete alerts** — `deleteManagedAlerts(page, prefixes)`: finds alert rows by ticker text prefix in the Alerts panel, clicks delete via DOM evaluation
2. **Delete watchlists** — `deleteManagedWatchlistsByPrefix(page, prefix)`: opens the "Open list" dialog and removes watchlists matching the prefix
3. **Import watchlists** — `importWatchlistFromFile(page, filePath, desiredName)`: triggers file upload via the "Upload list" menu item
4. **Create alerts** — `createWatchlistAlertIfPossible(page, listName)`: switches to each new watchlist, sets chart to 4H, opens the "Add alert to list" dialog, sets condition, and submits

### Watchlist naming convention

Watchlists are named `{prefix}_{YYYYMMDD_HHmm}` (JST), e.g. `wl1_20250411_0930`.  
`isManagedListName(name, prefix)` returns true if `name === prefix` OR `name.startsWith(prefix + "_")`.

### Environment variables

| Variable | Source | Purpose |
|---|---|---|
| `TRADINGVIEW_STORAGE_STATE` | Secret (JSON string) | Browser session cookies/localStorage for auth |
| `WATCHLIST_1_URL` / `WATCHLIST_2_URL` | Secret | URLs to download `.txt` watchlist files |
| `WATCHLIST_1_NAME` / `WATCHLIST_2_NAME` | Var | Prefix strings (default: `wl1`, `wl2`) |
| `DO_DELETE_ALERTS` / `DO_DELETE_WATCHLISTS` / `DO_IMPORT_WATCHLISTS` / `DO_CREATE_WATCHLIST_ALERT` | Env | Feature flags (`"true"`/`"false"`) |
| `ALERT_CONDITION_NAME` | Var | Exact display name of the indicator condition |
| `ALERT_TIMEFRAME_LABEL` | Var | e.g. `"4 時間"` |

### GitHub Actions workflows

**`update-tradingview.yml`** — Main workflow
- Triggers: `repository_dispatch` (type: `build_complete`) from an external "Builder" repo, plus `workflow_dispatch`
- Concurrency group `tv-watchlist-updater` cancels in-progress runs
- On failure/success: sends Discord webhook notifications
- Debug screenshots are uploaded as artifact `tv-debug` (from `tmp/**/*.png`)

**`autofix.yml`** — Triggered on failure of the main workflow (`workflow_run`)
- Creates a GitHub Issue with label `auto-fix-needed` (creates label first if missing)
- Saves debug screenshots to the `debug/screenshots` branch (orphan strategy)
- Only creates an issue if no open `auto-fix-needed` issue already exists

### Critical TradingView UI quirks encoded in the script

**Watchlist "Open list" dialog vs sidebar conflict**  
`div[data-role="list-item"]` matches BOTH rows in the "Open list" dialog AND ticker rows in the sidebar watchlist panel. Always use `div[data-role="list-item"][data-title]` when targeting dialog rows. To detect whether the dialog is currently open, check for `button[data-qa-id="close"]` (dialog-specific close button).

**Active watchlist has no trash icon**  
TradingView hides the delete button in the "Open list" dialog for the currently active watchlist. `deleteManagedWatchlistsByPrefix` handles this by:
1. Opening the dialog, finding a non-managed watchlist
2. Clicking it to switch the active watchlist (dialog closes)
3. Reopening the dialog via the full menu flow (`openWatchlistMenuHard` → click "リストを開く")
4. Now the managed watchlist is inactive → trash icon appears on hover

**Menu opening is fragile**  
`openWatchlistMenuHard` retries up to 8 times with fallbacks: normal click → coordinate click at the right edge → JS `dispatchEvent`. Verify with `[data-qa-id="active-watchlist-menu"]` or `[data-role="menu"]`.

**Alert slot release**  
After deleting alerts, TradingView takes time to free the alert slot. The script waits `ALERT_SLOT_RELEASE_WAIT_MS` (default 30s) before creating new alerts.

**Promo dialog**  
A "One alert to track an entire watchlist" upgrade dialog can appear and block interaction; `isWatchlistPromoDialogVisible` / `closeWatchlistPromoDialog` handle it.

### Screenshot debugging

Failed steps call `safeScreenshot(page, label)` which saves to `tmp/screenshot_{timestamp}_{label}.png`. These are uploaded as the `tv-debug` artifact and copied to the `debug/screenshots` branch by `autofix.yml`.
