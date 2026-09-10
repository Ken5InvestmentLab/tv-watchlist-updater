# tv-watchlist-updater

## TradingView alert webhook

Set GitHub Actions secret `TRADINGVIEW_ALERT_WEBHOOK_URL` to the existing
TradingView receiver's HTTPS URL. This is separate from the Discord webhooks
used for workflow success/failure messages. Local runs use the same environment
variable. Never commit the URL or browser credentials.

The updater validates this configuration before deleting alerts or watchlists,
explicitly enables Webhook on every replacement alert, and reopens the notification
form to verify the saved URL before creating the alert. TradingView's remembered
notification defaults are not reliable and are never used as the configuration.

## Auto-repair setup

This repository is set up for API-key-free auto-repair through Codex app automation.

1. Keep the Codex app automation `TV Watchlist Codex 30分監視` active.
2. The automation checks for open GitHub issues labeled `auto-fix-needed` every 30 minutes.
3. GitHub Actions does not run `openai/codex-action` and does not require `OPENAI_API_KEY`.
4. When `TV Watchlist Update (Playwright)` fails, `Auto-Fix Issue on Failure` creates one `auto-fix-needed` issue and saves debug screenshots to the `debug/screenshots` branch.
5. Codex inspects the issue, workflow logs, and screenshots from the local app session, prepares the smallest durable repair, pushes a repair branch, and opens/updates a PR.
6. To allow fully automatic merge, set GitHub repository variable `AUTOFIX_AUTO_MERGE=true`.
7. If `AUTOFIX_AUTO_MERGE` is missing or any value other than `true`, Codex leaves the repair PR open for review.
8. If `AUTOFIX_AUTO_MERGE=true`, Codex merges the verified repair PR, closes the linked issue, and re-runs the main workflow on `main`.

Enable full auto-merge:

```bash
gh variable set AUTOFIX_AUTO_MERGE --body true --repo Ken5InvestmentLab/tv-watchlist-updater
```

Disable full auto-merge:

```bash
gh variable delete AUTOFIX_AUTO_MERGE --repo Ken5InvestmentLab/tv-watchlist-updater
```

## TradingView login fallback

The updater first uses `TRADINGVIEW_STORAGE_STATE`. If that session is no longer logged in, it can try an automatic login when these optional GitHub Secrets are configured:

- `TRADINGVIEW_USERNAME` or `TRADINGVIEW_EMAIL`
- `TRADINGVIEW_PASSWORD`

If TradingView asks for 2FA/CAPTCHA, run `node save-storage-state.js` locally and update `TRADINGVIEW_STORAGE_STATE` instead.

## Local Chrome execution

The daily updater runs on this PC through a self-hosted GitHub Actions runner. It
connects to your normal Google Chrome `Default` profile at `127.0.0.1:9222`; it
does not launch an automated Chromium browser or upload that profile to GitHub.

Run `powershell -ExecutionPolicy Bypass -File scripts/setup-local-runner.ps1`
once from this repository. It downloads and registers the runner, starts the
ordinary Chrome profile, and schedules both at logon and 09:05 JST. If Windows
does not grant task-creation access, it installs a per-user Startup launcher
instead. Close all Chrome windows once, run the launcher, and use the already
logged-in normal Chrome profile. The builder's
existing `build_complete` event then runs the updater locally with the same
GitHub secrets as before.

If the normal profile is not signed in but a freshly captured local
`storageState.json` is available, run `node scripts/seed-local-chrome-session.js`
once to restore the TradingView session into the local Chrome profile.

The updater creates its own tab and never closes the user-visible Chrome
window. If another device disconnects the TradingView session, it detects the
`Session disconnected` dialog and clicks `Connect` up to three times.
