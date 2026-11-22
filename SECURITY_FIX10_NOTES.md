# PropIQ Security Audit — Fix 10

## Changes
- `app/api/history/route.ts`: Add `Cache-Control: private, no-store` and `Vary: Cookie` to all early JSON error responses (oversized body, invalid JSON, invalid sport, invalid player names), as successful and premium failures already do.
- `app/api/research/line-history/route.ts`: Restore the previously supplied Elite-only GET route at the exact Next.js app-router path. Its logic is unchanged.

## About the 404
The Elite Line History GET code already denies non-Elite users with 403. HTTP 404 means the deployed application isn't serving the route. Confirm this file is tracked, deployed and present at this exact path. If a production build succeeds but 404 persists, inspect Railway deployment logs and build commit; check for a conflicting `next.config` rewrite/middleware.

## Verification
Run `npm run build`, deploy, then `node scripts/security-audit.mjs https://propiq-app.up.railway.app`.
The expected 10/10 only confirms the signed-out tests. It does not establish paid-account authorization, RLS, or webhook correctness.
No odds provider or billing changes.
