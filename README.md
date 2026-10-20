# PropIQ — NFL + NBA player prop research dashboard

A Next.js research dashboard with live sportsbook player-prop fetching (your own The Odds API key), manual prop entry, CSV game-log import, last-5/10/20 historical hit rates, game-by-game breakdowns, filters, and saved props.

## Quick start

1. Install Node.js 20.9+.
2. Open this folder in VS Code and in the terminal run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. Register for an API key at https://the-odds-api.com/ and set `ODDS_API_KEY=your_key` in `.env.local` (keep it private).
5. Run `npm run dev` and visit http://localhost:3000.
6. Click **Fetch Live Odds** for NBA or NFL. By default only the next TWO upcoming games per sport are queried, cached for 5 minutes server-side to protect your free credits.
7. Use **Import Game Logs** to import player stat histories (CSV), then click any matching player prop.

## Critical data limitations

- Demo data is fictional and clearly labeled. Click **Fetch Live Odds** to replace the demo sport data with actual book-provided lines when available. No lines, odds, games or probabilities are invented in live mode.
- The Odds API player props are fetched from a server route (`app/api/odds/route.ts`). API quota, available markets, supported bookmakers, current coverage, and pricing depend on the provider and can change. Each event may cost quota for **multiple markets**. Check your usage dashboard.
- Live bookmaker lines DO NOT include game-by-game historical player statistics. You must import historical logs separately. BDL and other full stat APIs often require paid plans. `public/sample-game-logs.csv` shows the format.
- Match on `sport`, exact-ish `player` name (case/punctuation insensitive), and `marketKey`; ISO `date` required. CSV rows replace existing game-log rows for the same player+market. Do not mix seasons without intending to; `season` in the current UI is all imported history.
- No calibrated future probabilities are claimed. Hit rate is `number of games above/below the current line ÷ number of historical games` (pushes remain in the denominator). The displayed sportsbook implied probability includes margin/vig. Those numbers should not be confused with predictive confidence.
- Import, manual props and bookmarks live in browser `localStorage`, not on a shared server. Suitable for a personal MVP, **not yet suitable for public multi-user hosting**. For public launch use proper database/auth, rate limits, caching, provider licenses and compliance checks.
- The current site refreshes live odds **on button click**, not continuously; the API route caches each sport for five minutes per running server instance. A serverless deployment may have multiple cache instances. Do not put secret keys in `NEXT_PUBLIC_*` vars.
- The graph scales to each player's recent max game value and is not a comparative calibrated probability chart.

## Deploy to Railway (GitHub, recommended)

1. Extract this ZIP and open the inner `prop-iq` folder in VS Code (or Cursor).
2. Run `npm install` and `npm run build` locally to verify the production build.
3. Create a new GitHub repository, and push **the contents of the `prop-iq` folder** to the repo root; ensure `package.json` and `railway.json` are at its root. **Do not commit `.env.local` or secrets**.
4. Visit https://railway.com/new and choose **Deploy from GitHub repo**, select your repository.
5. Under the new Railway service's **Variables** tab, create `ODDS_API_KEY` and paste your actual key. Leave it blank until you have an API key; the dashboard's manual/CSV features still work without one. Don't prefix the key with `NEXT_PUBLIC_`.
6. Railway's Railpack builder runs `npm run build` and then `npm run start` according to `railway.json`. The Next.js server automatically accepts the Railway `PORT` environment variable. You don't need to define PORT yourself.
7. In the service's **Settings → Networking**, choose **Generate Domain**. After deploy, browse the generated public URL.
8. Push later code updates to GitHub; Railway will automatically build and redeploy.

**Important:** Railway usage isn't guaranteed to be completely free; check your account's trial credits, billing and current pricing. Your API provider may also bill for odds usage. Browser-local CSV uploads/bookmarks are **not shared** between users, browsers, devices, or deployments. Production multi-user analytics will require persistent storage and authentication.

If you instead place the entire ZIP's `prop-iq/` folder at the repository root (rather than its contents), set Railway's service **Root Directory** to `/prop-iq`.

See https://docs.railway.com/guides/nextjs for Railway's official Next.js instructions.

## File map

- `app/page.tsx`: dashboard, filtering, drawers, import, manual form, saved props
- `app/globals.css`: responsive dark UI
- `app/api/odds/route.ts`: secure odds API integration, usage cap, cache
- `lib/props.ts`: market definitions, historical analytics, CSV parser, fictional demo
- `public/sample-game-logs.csv`: sample CSV schema
- `railway.json`: Railpack build and start configuration for Railway

## Suggested next steps

1. Connect licensed historical game-log data for NBA and NFL; ensure stat coverage matches markets.
2. Add per-user data storage (Supabase/Postgres) and sign-in.
3. Add timestamps on each line, robust name mappings, injury/context analytics.
4. Develop and **backtest** calibrated future forecasts (out-of-sample) before displaying confidence/edge.
5. Add job-based prefetch and persistent caching for the full schedule, after increasing quota.
6. Review licensing, state-by-state gambling advertising rules, age gating, and privacy policy before public launch.
