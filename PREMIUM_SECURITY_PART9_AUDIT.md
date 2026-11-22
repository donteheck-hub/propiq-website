# PropIQ Premium API Security — Update #9

## Source-audit findings (not a penetration test)

- Supabase session verification is performed server-side for paid membership checks.
- Pro/Elite trend-summary, matchup-summary and sportsbook comparison routes check permissions.
- Elite dashboard and line-history routes check Elite membership before returning results.
- Stripe sandbox webhook checks HMAC signatures and test-mode events; subscriptions are stored through an RPC.
- Bookmark write endpoint requires matching origin, authenticated session, and Supabase RLS.
- Odds provider quota uses an on-disk daily cache. **The public odds GET route can still trigger the scheduled daily refresh**. The test script intentionally NEVER calls it.

## Fix included

`app/api/history/route.ts` now caps Free/Pro history by player and stat across the full requested range, rather than per season. This prevents selecting `season: all` from multiplying the history allowance across seasons. History GET responses also set `Cache-Control: private, no-store`.

## Run smoke tests

From the project root, after deployment:

`node scripts/security-audit.mjs https://propiq-app.up.railway.app`

This only tests signed-out and deliberately forged-tier requests. It never uses a browser session, odds provider request, paid checkout, or write to Supabase.

## Remaining launch blockers / manual tests

1. Run a production `npm run build`; check for Next.js runtime/type errors.
2. Run the audit script and confirm 10/10 pass. A 503 may signal a configuration outage; do not treat it as a pass.
3. Test Free/Pro/Elite sessions by calling each API with real cookies in a controlled environment; verify each tier is blocked or allowed as intended.
4. Check Supabase RLS from two separate authenticated accounts, including direct REST API requests; do not rely only on UI bookmark isolation.
5. Verify cancellation and expiry as before. Test webhook delivery retry and replay using Stripe's test tools.
6. Check the actual production deployed Git commit equals the audited local source; this package is based on the most recent available workspace copy, not independently fetched from Railway.
7. The public odds data and Free game logs still permit manual recomputation of some premium research. Endpoint checks protect *services*, not the mathematics or public market prices.
8. No application-level rate limiter was verified for costly history/research requests. Consider per-user/IP throttling before public launch.
9. Line history is generated only when an Elite reader requests it; there is no background collector. File persistence assumes a single process with a persistent volume, not distributed replicas.
10. Test authenticated CSRF behavior, cookies' Secure/SameSite/HttpOnly attributes, origin configuration and HTTPS on the deployed auth route.

**Keep Stripe in sandbox/test mode until these checks pass.**
