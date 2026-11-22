# PropIQ Premium Security Part 8 — Elite Line History

- The new `/api/research/line-history?sport=NBA|NFL` endpoint verifies an active Elite subscription on each request.
- Reads existing `/data/propiq/odds-state.json` directly. **No additional odds provider API calls or credits.**
- Stores 30-day, max-12,000-record shared snapshots on the existing Railway volume in `line-history-state.json`.
- Snapshot collection starts when an Elite user opens Line History or Research Dashboard. If no Elite user visits on a given provider refresh, that day's snapshot is not retained by this endpoint.
- Historical browser localStorage snapshots are not uploaded, deleted, or migrated; the new Elite view displays only trusted server records.
- A fresh timestamp alone may produce a baseline. Only consecutive provider snapshots can show genuine recorded changes. No intraday movements are fabricated.
- Requires `ODDS_CACHE_DIR=/data/propiq` and the Railway volume already used for odds persistence.
- This does **not** protect the public underlying live prices or complete the final security audit.
- Validate `npm run build` and test signed-out/Free/Pro/Elite behavior after deployment.
