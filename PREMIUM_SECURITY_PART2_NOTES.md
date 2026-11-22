# PropIQ Premium API Security — Part 2

Changed file only: `app/api/history/route.ts`.

Adds server-side premium `trend-summary` mode to POST `/api/history`.
Example JSON body (active Pro/Elite session cookie required):

```json
{"sport":"NBA","season":"all","mode":"trend-summary","trends":[{"player":"Example Player","marketKey":"player_points","line":20.5,"side":"Over"}]}
```

- Guest/Free: 403; Pro/Elite: server-computed Last 10/20 summaries.
- Per-request limit: 20 trends; invalid markets, lines, player names, JSON rejected.
- No client-supplied game outcomes accepted. No Odds API calls or quota spending.
- Existing Free history flow remains intact.

Important: This introduces a protected calculation API, but the current Smart Finder, Matchup Center, Odds Comparison, and Elite views still compute some information in the browser. They have NOT been migrated to this endpoint and the paywall is NOT fully secure. Backend data architecture requires further work before public sale. No changes to persistent odds caching.
