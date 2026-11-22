# Premium Security Part 3 — Smart Finder server verification

## Scope
- Adds an authenticated `trend-summary` call whenever a Pro/Elite member opens a **live** prop from Smart Finder.
- Displays Last 10 and Last 20 server-calculated observations in the existing research drawer.
- Never calls the Odds API and does not alter the daily odds cache.
- Preserves the existing Finder filters and rankings until full server-side migration.

## Verify
1. Install these two files into the same paths and run `npm run build`.
2. Sign in as Pro and open Smart Finder, then click a live prop. Wait for **Server-verified Smart Finder result**.
3. Check that Last 10 matches existing numbers where samples match and Last 20 can show full history.
4. If verification says unavailable, inspect POST `/api/history` in browser DevTools Network. HTTP 403 means missing authentication/entitlement; HTTP 502 means history provider unavailable.
5. Confirm Free users still see the basic explorer and cannot open Smart Finder.

## Security limitation
This is a deliberate non-breaking integration step. **Smart Finder rankings, matchup tools, and odds comparisons still run in browser code** and browser-visible data still permits reproducing some research. Do not sell this as a completed paywall. Full server-side search, sorting, and premium data isolation are still necessary.
