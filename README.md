# tv-watchlist-updater

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
