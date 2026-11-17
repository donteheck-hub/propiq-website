# PropIQ Phase 3 — Security and subscription test checklist

**Sandbox only. Do not enable real payments based on these tests.**

## Automated local test

In the project root run `node scripts/security-smoke.mjs` and `npm run build`.
The first command runs offline entitlement tests only; it does **not** test deployed Supabase, Stripe, or browser access.

## Manual acceptance tests

1. **Logged out / Free:** Prop Explorer and local saved props are available. Smart Finder, Matchup Center, Odds Comparison, Line History and Research Dashboard should be gated based on their tiers. The GET `/api/entitlements` result should say `free`.
2. **Pro test account:** Sign in with the already active Pro sandbox subscription. Smart Finder, Matchup Center, Odds Comparison unlocked. Line History and Research Dashboard locked.
3. **Elite:** Use a separate test account and complete Elite sandbox checkout. Check the subscription row and Elite-only UI.
4. **Expiration / cancellation:** In Stripe Sandbox cancel a test subscription. After the webhook has delivered successfully, confirm Supabase status, refresh PropIQ and verify the membership is now Free according to the policy. Do not manually edit the table to simulate a Stripe cancellation.
5. **Webhook:** Confirm the expected subscription event delivers HTTP 200, verify Supabase row and observe duplicate re-delivery does not create a second record or revert a newer status. Invalid signatures should be rejected. Do not send real or live events to this test endpoint.
6. **Checkout:** If an account already has active Pro or Elite, attempting a second test checkout should be rejected. Upgrades and downgrades need a separate supported flow.
7. **Authentication:** Sign out and verify premium UI locks; test expired sessions and refresh. Ensure all credentials remain only in server-side Railway variables.
8. **Saved props:** Save with account A; ensure account B cannot read account A's records (Supabase RLS) and sign out does not expose A's cloud bookmarks.
9. **Billing origin:** Cross-site POST attempts to `/api/billing` should return 403. Do not disable origin checks to repair a domain misconfiguration.
10. **Data access:** `/api/odds` and `/api/history` still serve data for the free explorer. Premium analytics are presently derived in the browser and cannot be securely monetized without moving premium-only computation/data to gated server endpoints.

## Before charging real customers

- Obtain Stripe's approval for the proposed sports-betting research offering.
- Implement a cancellation/customer portal and safe upgrade/downgrade flow.
- Implement shared backend authorization for premium-only analytics and close any public endpoints exposing paid-only data.
- Add rate limiting, monitoring, incident response, and terms/privacy disclosures.
- Run full live end-to-end tests for payments, refunds, failed renewals, disputed payments, account deletion and webhook replay.
- Switch to live billing only after a distinct security review. The included code explicitly remains **Stripe Sandbox only**.
