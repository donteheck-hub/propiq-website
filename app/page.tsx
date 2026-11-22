
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownUp, BarChart3, Bookmark, CalendarDays,
  ChevronDown, CircleHelp, Download, FileUp, Filter,
  LayoutDashboard, Menu, Plus, RefreshCw, Search, ShieldCheck, Sparkles, ArrowLeftRight,
  SlidersHorizontal, Target, TrendingUp, X, Shield, History, Gauge, ArrowUpRight, Database
} from 'lucide-react';
import AccountAccess from './components/AccountAccess';
import BillingTestActions from './components/BillingTestActions';
import {
  analyze, currentSeason, defenseContext, type DefenseRow, gameOpponent, gameVenue, implied, logSeason, type LogRow, MARKETS, normalize, recentTrends, parseCsv, parseDefenseCsv, type Prop, seasonLabel, splitHistory, type Sport
} from '../lib/props';

const STORAGE_KEY = 'prop-iq-v2';
type OddsSample = { sport: Sport; player: string; event: string; commence: string; market: string; marketKey: string; side: 'Over'|'Under'; bookmaker: string; line: number; odds: number; observedAt: string };
const sampleKey = (p: Pick<OddsSample, 'sport'|'player'|'event'|'commence'|'marketKey'|'side'|'bookmaker'>) => [p.sport, normalize(p.player), normalize(p.event), p.commence, p.marketKey, p.side, normalize(p.bookmaker)].join('|');
// A bookmaker's line and odds can change. Neither should invalidate a bookmark.
const bookmarkKey = (p: Prop) => `saved:v2:${sampleKey(p)}`;
const isSaved = (p: Prop, saved: string[]) => saved.includes(bookmarkKey(p)) || saved.includes(p.id);
const validLiveProp = (p: unknown, sport: Sport): p is Prop => {
  if (!p || typeof p !== 'object') return false;
  const v = p as Partial<Prop>;
  return v.source === 'live' && v.sport === sport &&
    typeof v.id === 'string' && v.id.length > 0 &&
    typeof v.player === 'string' && v.player.trim().length > 0 &&
    typeof v.marketKey === 'string' && !!MARKETS[sport][v.marketKey] &&
    typeof v.bookmaker === 'string' && v.bookmaker.trim().length > 0 &&
    typeof v.event === 'string' && typeof v.commence === 'string' &&
    (v.side === 'Over' || v.side === 'Under') &&
    typeof v.line === 'number' && Number.isFinite(v.line) && v.line >= 0 &&
    typeof v.odds === 'number' && Number.isFinite(v.odds) &&
    (v.odds <= -100 || v.odds >= 100);
};

const PAGE_SIZE = 40;
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MIN_SAMPLE_FOR_HIGHLIGHT = 10;

function Pill({
  children,
  kind = 'neutral'
}: {
  children: React.ReactNode;
  kind?: string;
}) {
  return <span className={'pill ' + kind}>{children}</span>;
}

const pct = (n: number | null | undefined) =>
  n == null ? '—' : `${n}%`;

function fmtOdds(n: number) {
  return n > 0 ? `+${n}` : `${n}`;
}

type LiveStatus = 'loading' | 'live' | 'cached' | 'stale' | 'unavailable';
type SportsbookFilter = 'both' | 'draftkings' | 'fanduel';
type SortField = 'last5' | 'last10' | 'average';

type SecureOddsComparison = { best: Prop; other: Prop; gain: number };
type EliteDashboardData = { coverage: { live: number; uniquePlayers: number; withHistory: number; fullTen: number }; trends: Array<{ prop: Prop; hits: number; games: number; rate: number }> };
type VerifiedTrendSample = { games: number; hits: number; pushes: number; misses: number; hitRate: number | null; average: number | null };
type VerifiedTrend = { last5?: VerifiedTrendSample; last10: VerifiedTrendSample; last20: VerifiedTrendSample };
const FINDER_MAX_CANDIDATES = 120;
type MatchupSummary = {
  all: { games: number; hits: number; pushes: number; average: number | null };
  opponents: Array<{ opponent: string; games: number; hits: number; pushes: number; average: number | null }>;
};
const MATCHUP_MAX_CANDIDATES = 120;
const finderTrendKey = (p: Pick<Prop, 'player' | 'marketKey' | 'line' | 'side'>) =>
  [normalize(p.player), p.marketKey, p.line, p.side].join('|');


const profitOn100 = (odds: number) => odds > 0 ? odds : 10000 / Math.abs(odds);

const normalizeBook = (name: string) =>
  name.toLowerCase().replace(/[^a-z]/g, '');

// Images are optional enhancements: if the historical provider does not supply a
// verified NBA person ID, or the CDN has no photo, use an initials avatar.
function PlayerAvatar({ name, nbaPlayerId, nflHeadshotUrl, size = 'table' }: { name: string; nbaPlayerId?: number; nflHeadshotUrl?: string; size?: 'table' | 'large' }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || 'PI';
  const imageUrl = nflHeadshotUrl || (Number.isSafeInteger(nbaPlayerId) && nbaPlayerId ? `https://cdn.nba.com/headshots/nba/latest/260x190/${nbaPlayerId}.png` : undefined);
  const showPhoto = !!imageUrl && imageUrl !== failedUrl;
  return (
    <span className={'player-avatar ' + (size === 'large' ? 'avatar-large' : '')} aria-hidden="true">
      {showPhoto ? (
        <img src={imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(imageUrl || null)} />
      ) : <span>{initials}</span>}
    </span>
  );
}

export default function Home() {
  const [sport, setSport] = useState<Sport>('NBA');
  const [seasonView, setSeasonView] = useState<'current' | 'previous' | 'all'>('current');
  const [sortField, setSortField] = useState<SortField>('last10');
  const [sortDescending, setSortDescending] = useState(true);
  const [tab, setTab] = useState<'dashboard' | 'explore' | 'saved' | 'finder' | 'odds' | 'matchups' | 'movement'>('explore');
  const [membership, setMembership] = useState<'loading' | 'free' | 'pro' | 'elite'>('loading');
  const [membershipMessage, setMembershipMessage] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [props, setProps] = useState<Prop[]>([]);
  const [oddsSamples, setOddsSamples] = useState<OddsSample[]>([]);
  const [lineHistoryStatus, setLineHistoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [lineHistoryError, setLineHistoryError] = useState('');
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [autoLogs, setAutoLogs] = useState<LogRow[]>([]);
  const [historyStatus, setHistoryStatus] = useState('Loading historical game data...');
  const [historyDiagnostics, setHistoryDiagnostics] = useState<string[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [status, setStatus] = useState<LiveStatus>('loading');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [market, setMarket] = useState('all');
  const [sportsbook, setSportsbook] = useState<SportsbookFilter>('both');
  const [side, setSide] = useState('all');
  const [minHit, setMinHit] = useState(0);
  const [finderThreshold, setFinderThreshold] = useState(70);
  const [finderSample, setFinderSample] = useState<10 | 20>(10);
  const [secureComparisons, setSecureComparisons] = useState<SecureOddsComparison[]>([]);
  const [eliteDashboard, setEliteDashboard] = useState<EliteDashboardData | null>(null);
  const [eliteDashboardStatus, setEliteDashboardStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [eliteDashboardError, setEliteDashboardError] = useState('');
  const [comparisonStatus, setComparisonStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [comparisonError, setComparisonError] = useState('');
  const [matchupOpponent, setMatchupOpponent] = useState('all');
  const [matchupVerified, setMatchupVerified] = useState<Map<string, MatchupSummary>>(new Map());
  const [matchupStatus, setMatchupStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [matchupError, setMatchupError] = useState('');
  const [selected, setSelected] = useState<Prop | null>(null);
  const [opponentView, setOpponentView] = useState('all');
  const [verifiedTrend, setVerifiedTrend] = useState<VerifiedTrend | null>(null);
  const [finderVerified, setFinderVerified] = useState<Map<string, VerifiedTrend>>(new Map());
  const [finderStatus, setFinderStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [finderError, setFinderError] = useState('');
  const [finderChecked, setFinderChecked] = useState(0);
  const [verifiedTrendStatus, setVerifiedTrendStatus] = useState<'idle' | 'loading' | 'verified' | 'error'>('idle');
  const [verifiedTrendMessage, setVerifiedTrendMessage] = useState('');
  const [defenseTeam, setDefenseTeam] = useState('');
  const [defenseRows, setDefenseRows] = useState<DefenseRow[]>([]);
  const [defenseError, setDefenseError] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  const [cloudAccount, setCloudAccount] = useState<string | null>(null);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudMessage, setCloudMessage] = useState('');
  const browserSaved = useRef<string[]>([]);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [modal, setModal] = useState(false);
  const [help, setHelp] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [importError, setImportError] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [oddsCoverage, setOddsCoverage] = useState('');
  const [page, setPage] = useState(1);

  const file = useRef<HTMLInputElement>(null);
  const defenseFile = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  // Restore manually entered props, imported logs, and bookmarks.
  // The new storage key prevents fictional v1 demo logs from
  // being presented as genuine historical data.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);

        if (Array.isArray(data.props)) {
          setProps(data.props.filter(
            (p: Prop) => p.source === 'manual'
          ));
        }

        if (Array.isArray(data.logs)) setLogs(data.logs);
        if (Array.isArray(data.saved)) {
          const keys = data.saved.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512);
          browserSaved.current = keys;
          setSaved(keys);
        }
        if (Array.isArray(data.defenseRows)) setDefenseRows(data.defenseRows.filter((r: DefenseRow) => r && (r.sport === 'NBA' || r.sport === 'NFL') && Number.isFinite(r.allowedPerGame) && Number.isInteger(r.season) && typeof r.team === 'string' && typeof r.source === 'string'));
      }
    } catch (error) {
      console.error('Unable to restore saved research:', error);
    }

    setHydrated(true);
  }, []);

  // Only manual props and historical logs are persisted.
  // Live prices are always obtained from the API again.
  useEffect(() => {
    if (!hydrated) return;

    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          props: props.filter(p => p.source === 'manual'),
          logs,
          saved: cloudAccount ? browserSaved.current : saved,
          defenseRows
        })
      );
    } catch (error) {
      console.error('Unable to save research:', error);
    }
  }, [hydrated, props, logs, saved, defenseRows, cloudAccount]);

  // Account bookmarks use Supabase with per-user RLS. Browser bookmarks remain
  // separate and are never silently uploaded to a different person's account.
  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    async function loadAccount(userId: string | null) {
      setCloudReady(false);
      setCloudAccount(userId);
      setCloudMessage('');
      if (!userId) {
        setSaved(browserSaved.current);
        return;
      }
      setSaved([]); // Never display one account's bookmarks for another account.
      try {
        const response = await fetch('/api/saved-props', { cache: 'no-store' });
        const result = await response.json() as { saved?: unknown; error?: string };
        if (!response.ok || !Array.isArray(result.saved)) throw Error(result.error || 'Unable to load bookmarks.');
        if (active) {
          setSaved(result.saved.filter((v): v is string => typeof v === 'string'));
          setCloudReady(true);
        }
      } catch (error) {
        if (active) setCloudMessage(error instanceof Error ? error.message : 'Cloud bookmarks unavailable.');
      }
    }
    const onAccount = (event: Event) => { void loadAccount((event as CustomEvent<string | null>).detail); };
    window.addEventListener('propiq-auth-change', onAccount);
    // Covers the rare case when account UI initializes before this listener.
    void fetch('/api/auth', { cache: 'no-store' }).then(r => r.json())
      .then((result: { user?: { id?: string } | null }) => { if (active) void loadAccount(result.user?.id || null); })
      .catch(() => { if (active) void loadAccount(null); });
    return () => { active = false; window.removeEventListener('propiq-auth-change', onAccount); };
  }, [hydrated]);

  // The server verifies the Supabase session and the current subscription record.
  // Never use the plan name stored in browser storage as an entitlement.
  useEffect(() => {
    let active = true;
    let requestNumber = 0;
    const loadMembership = async () => {
      const current = ++requestNumber;
      if (active) setMembership('loading');
      try {
        const res = await fetch('/api/entitlements', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error('Membership verification unavailable.');
        const data = await res.json() as {tier?: 'free' | 'pro' | 'elite'; notice?: string};
        if (!active || current !== requestNumber) return;
        setMembership(data.tier === 'elite' ? 'elite' : data.tier === 'pro' ? 'pro' : 'free');
        setMembershipMessage(data.notice || '');
      } catch {
        if (!active || current !== requestNumber) return;
        setMembership('free');
        setMembershipMessage('Could not verify membership. Premium access is temporarily locked.');
      }
    };
    const onChange = () => { void loadMembership(); };
    window.addEventListener('propiq-auth-change', onChange);
    void loadMembership();
    return () => { active = false; window.removeEventListener('propiq-auth-change', onChange); };
  }, []);

  const hasPro = membership === 'pro' || membership === 'elite';
  const hasElite = membership === 'elite';
  const requiredMembership = (selectedTab: typeof tab): 'pro' | 'elite' | null =>
    selectedTab === 'dashboard' || selectedTab === 'movement' ? 'elite' :
    selectedTab === 'finder' || selectedTab === 'odds' || selectedTab === 'matchups' ? 'pro' : null;
  const currentRequiredTier = requiredMembership(tab);
  const lockedTab = currentRequiredTier !== null && (currentRequiredTier === 'elite' ? !hasElite : !hasPro);

  // Send updates after the user changes a bookmark; never send browser history
  // or imported game logs to the cloud.
  const cloudInitialized = useRef(false);
  useEffect(() => {
    if (!cloudAccount || !cloudReady) { cloudInitialized.current = false; return; }
    if (!cloudInitialized.current) { cloudInitialized.current = true; return; }
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/saved-props', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin', body: JSON.stringify({ saved })
        });
        if (!response.ok) {
          const result = await response.json() as { error?: string };
          throw Error(result.error || 'Unable to sync bookmarks.');
        }
        setCloudMessage('');
      } catch (error) {
        setCloudMessage(error instanceof Error ? error.message : 'Bookmark sync failed.');
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [saved, cloudAccount, cloudReady]);

  const refresh = useCallback(async (selectedSport: Sport) => {
    const currentRequest = ++requestId.current;

    setLoading(true);
    setStatus('loading');
    setNotice('');

    try {
      const response = await fetch(
        `/api/odds?sport=${selectedSport}`,
        { cache: 'no-store' }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Live odds request failed.');
      }

      if (data.configured === false) {
        throw new Error(
          data.message || 'ODDS_API_KEY is not configured on the server.'
        );
      }

      if (!Array.isArray(data.props)) {
        throw new Error('Invalid response from the live odds API.');
      }

      // Ignore an older request if the user switched sports.
      if (currentRequest !== requestId.current) return;

      // Reject malformed or cross-sport outcomes without hiding valid prices.
      const valid = (data.props as unknown[]).filter((p): p is Prop => validLiveProp(p, selectedSport));
      const unique = new Map<string, Prop>();
      for (const prop of valid) unique.set(prop.id, prop);
      const liveProps = [...unique.values()];

      setProps(previous => [
        ...previous.filter(
          p =>
            p.source === 'manual' ||
            (p.source === 'live' && p.sport !== selectedSport)
        ),
        ...liveProps
      ]);

      setStatus(data.stale ? 'stale' : data.cached ? 'cached' : 'live');
      setOddsCoverage(typeof data.availableEvents === 'number' ? `Odds coverage: ${data.eventsChecked} of ${data.availableEvents} upcoming games checked. ${Array.isArray(data.warnings) && data.warnings.length ? `${data.warnings.length} provider error(s).` : ''}` : '');
      setLastUpdated(data.updatedAt ? new Date(data.updatedAt).toLocaleString() : new Date().toLocaleTimeString());

      setNotice(
        data.message ||
        `${liveProps.length} ${data.stale ? 'outdated' : 'available'} ${selectedSport} props. ${data.notice || ''} ${data.creditStatus ? `Local daily quota estimate: ${data.creditStatus.usedToday}/${data.creditStatus.dailyBudget} credits. ${data.creditStatus.providerRemaining == null ? '' : `Provider reports ${data.creditStatus.providerRemaining} remaining.`}` : ''}`
      );
    } catch (error) {
      if (currentRequest !== requestId.current) return;

      setStatus('unavailable');
      setOddsCoverage('');
      setNotice(
        error instanceof Error
          ? error.message
          : 'Unable to retrieve live player props.'
      );
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
      }
    }
  }, []);

  // Automatically retrieve props when the website first opens,
  // and whenever the selected sport changes.
  useEffect(() => {
    if (hydrated) {
      void refresh(sport);
    }
  }, [hydrated, sport, refresh]);

  // Ask the server ONLY for players offered in the current sportsbook lines.
  // The full NFL dataset stays server-side, never in the browser.
  const historyPlayers = useMemo(() => Array.from(new Set(
    props.filter(p => p.sport === sport &&
      ['draftkings', 'fanduel'].includes(normalizeBook(p.bookmaker)))
      .map(p => p.player.trim()).filter(Boolean)
  )).sort(), [props, sport]);
  const historyPlayerKey = historyPlayers.join('|');

  // Request a small set of players at a time. A single full-roster response can
  // exceed the 5 MB browser safety limit even when the server has valid history.
  useEffect(() => {
    if (!hydrated) return;
    if (historyPlayers.length === 0) {
      setAutoLogs(previous => previous.filter(r => r.sport !== sport));
      setHistoryStatus('No current sportsbook players to match with historical game logs.');
      setHistoryDiagnostics([]);
      setHistoryLoading(false);
      return;
    }
    const controller = new AbortController();
    const selectedSeason = seasonView === 'all' ? 'all' :
      currentSeason(sport) - (seasonView === 'previous' ? 1 : 0);
    const batchSize = 8;
    const playerBatches: string[][] = [];
    for (let i = 0; i < historyPlayers.length; i += batchSize) {
      playerBatches.push(historyPlayers.slice(i, i + batchSize));
    }
    setHistoryStatus(`Loading ${sport} history for ${historyPlayers.length} players in ${playerBatches.length} smaller requests...`);
    setHistoryDiagnostics([]);
    setHistoryLoading(true);
    const timer = setTimeout(() => controller.abort(), 120000);

    async function load() {
      const combined: LogRow[] = [];
      const diagnostics = new Set<string>();
      const failures: string[] = [];
      let completed = 0;
      let nextBatch = 0;
      try {
        async function worker() {
          while (nextBatch < playerBatches.length && !controller.signal.aborted) {
            const index = nextBatch++;
            try {
              const response = await fetch('/api/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sport, players: playerBatches[index], season: selectedSeason }),
                cache: 'no-store',
                signal: controller.signal
              });
              if (!response.ok) {
                const error = await response.json().catch(() => null);
                throw new Error(typeof error?.message === 'string' ? error.message : `History API returned ${response.status}`);
              }
              const size = Number(response.headers.get('content-length') || 0);
              if (size > MAX_HISTORY_BYTES) throw new Error('A player-history batch exceeded 5 MB');
              const text = await response.text();
              if (text.length > MAX_HISTORY_BYTES) throw new Error('A player-history batch exceeded 5 MB');
              const data = JSON.parse(text);
              if (!Array.isArray(data.rows)) throw new Error('Invalid history response');
              combined.push(...(data.rows as LogRow[]).filter(r =>
                r && r.sport === sport && typeof r.player === 'string' &&
                typeof r.marketKey === 'string' && typeof r.date === 'string' &&
                typeof r.value === 'number' && Number.isFinite(r.value) &&
                r.value >= 0 && !!MARKETS[sport][r.marketKey]
              ));
              if (Array.isArray(data.diagnostics)) {
                for (const item of data.diagnostics) if (typeof item === 'string') diagnostics.add(item);
              }
            } catch (error) {
              if (controller.signal.aborted) return;
              failures.push(`Batch ${index + 1}: ${error instanceof Error ? error.message : 'Request failed'}`);
            }
            completed++;
            if (!controller.signal.aborted) {
              setHistoryStatus(`Loading ${sport} game logs: ${completed}/${playerBatches.length} batches checked...`);
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(3, playerBatches.length) }, () => worker()));
        if (controller.signal.aborted) return;
        const unique = new Map<string, LogRow>();
        for (const row of combined) {
          unique.set(`${row.sport}|${normalize(row.player)}|${row.marketKey}|${row.date}`, row);
        }
        const verifiedRows = [...unique.values()];
        setAutoLogs(previous => [...previous.filter(r => r.sport !== sport), ...verifiedRows]);
        const summary = `${verifiedRows.length} ${sport} historical observations loaded for ${historyPlayers.length} requested players (${completed - failures.length}/${playerBatches.length} batches succeeded).`;
        setHistoryStatus(failures.length ? `${summary} Some requests failed; see diagnostics.` :
          verifiedRows.length ? summary : `${summary} The data source may not have matching games for this season; see diagnostics.`);
        setHistoryDiagnostics([...failures, ...diagnostics].slice(0, 12));
      } catch (error) {
        if (!controller.signal.aborted) {
          setAutoLogs(previous => previous.filter(r => r.sport !== sport));
          setHistoryStatus(`History unavailable: ${error instanceof Error ? error.message : 'Unknown error'}.`);
          setHistoryDiagnostics([...failures, ...diagnostics].slice(0, 12));
        }
      } finally {
        clearTimeout(timer);
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  // The player key is sorted and stable; season changes deliberately refetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sport, historyPlayerKey, seasonView]);

  // Use only provider-supplied player identifiers or verified NFL photo links.
  const playerHeadshots = useMemo(() => {
    const ids = new Map<string, { nbaPlayerId?: number; nflHeadshotUrl?: string }>();
    for (const row of [...autoLogs, ...logs]) {
      if (row.sport === 'NBA' && Number.isSafeInteger(row.nbaPlayerId) &&
          (row.nbaPlayerId ?? 0) >= 1000 && (row.nbaPlayerId ?? 0) < 100000000) {
        ids.set(`NBA|${normalize(row.player)}`, { nbaPlayerId: row.nbaPlayerId });
      }
      if (row.sport === 'NFL' && row.nflHeadshotUrl && /^https:\/\//.test(row.nflHeadshotUrl)) {
        ids.set(`NFL|${normalize(row.player)}`, { nflHeadshotUrl: row.nflHeadshotUrl });
      }
    }
    return ids;
  }, [autoLogs, logs]);

  const allLogs = useMemo(() => {
    const map = new Map<string, LogRow>();
    for (const row of autoLogs) {
      map.set(`${row.sport}|${normalize(row.player)}|${row.marketKey}|${row.date}`, row);
    }
    for (const row of logs) {
      map.set(`${row.sport}|${normalize(row.player)}|${row.marketKey}|${row.date}`, row);
    }
    return [...map.values()];
  }, [logs, autoLogs]);

  // Index game logs once, rather than scanning the entire dataset for each prop.
  const logIndex = useMemo(() => {
    const index = new Map<string, LogRow[]>();
    for (const row of allLogs) {
      const key = `${row.sport}|${normalize(row.player)}|${row.marketKey}`;
      const current = index.get(key);
      if (current) current.push(row);
      else index.set(key, [row]);
    }
    return index;
  }, [allLogs]);

  const seasonFor = useCallback((value: Sport) =>
    seasonView === 'all' ? undefined : currentSeason(value) - (seasonView === 'previous' ? 1 : 0),
  [seasonView]);
  const analyzed = useMemo(() => {
    const memo = new Map<string, ReturnType<typeof analyze>>();
    return props.map(p => {
      const key = `${p.sport}|${normalize(p.player)}|${p.marketKey}|${p.side}|${p.line}|${seasonView}`;
      let stats = memo.get(key);
      if (!stats) {
        const matching = logIndex.get(`${p.sport}|${normalize(p.player)}|${p.marketKey}`) || [];
        stats = analyze(p, matching, seasonFor(p.sport));
        memo.set(key, stats);
      }
      return { ...p, stats };
    });
  }, [props, logIndex, seasonView, seasonFor]);

  const seasonAvailable = useMemo(() => allLogs.filter(r => r.sport === sport &&
    (seasonView === 'all' || logSeason(r) === seasonFor(sport))).length,
  [allLogs, sport, seasonView, seasonFor]);
  const sportProps = useMemo(() => analyzed.filter(p => p.sport === sport), [analyzed, sport]);

  // Only compare identical, live outcomes across distinct sportsbooks.
  // Do not compare the same player at different lines or for different games.
  // The server owns comparison grouping and profitability calculations. Local filters
  // only narrow the server-authorized rows; browser-supplied props cannot be ranked.
  useEffect(() => {
    if (!((tab === 'odds' && hasPro) || (tab === 'dashboard' && hasElite))) {
      setSecureComparisons([]); setComparisonStatus('idle'); setComparisonError('');
      return;
    }
    const controller = new AbortController();
    setSecureComparisons([]); setComparisonError(''); setComparisonStatus('loading');
    void (async () => {
      try {
        const response = await fetch(`/api/odds/compare?sport=${sport}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal
        });
        const data = await response.json() as { comparisons?: unknown; error?: string; message?: string };
        if (!response.ok || !Array.isArray(data.comparisons)) {
          throw new Error(data.error || data.message || 'Comparison verification failed.');
        }
        const rows = data.comparisons.filter((v): v is SecureOddsComparison => {
          if (!v || typeof v !== 'object') return false;
          const r = v as Partial<SecureOddsComparison>;
          return validLiveProp(r.best, sport) && validLiveProp(r.other, sport) &&
            typeof r.gain === 'number' && Number.isFinite(r.gain) && r.gain >= 0;
        });
        if (!controller.signal.aborted) { setSecureComparisons(rows); setComparisonStatus('ready'); }
      } catch (error) {
        if (!controller.signal.aborted) {
          setSecureComparisons([]); setComparisonStatus('error');
          setComparisonError(error instanceof Error ? error.message : 'Comparison verification failed.');
        }
      }
    })();
    return () => controller.abort();
  }, [tab, hasPro, hasElite, sport]);

  const oddsComparisons = useMemo(() => secureComparisons.filter(({ best, other }) =>
    (market === 'all' || best.marketKey === market) &&
    (side === 'all' || best.side === side) &&
    `${best.player} ${best.event} ${best.bookmaker} ${other.bookmaker}`.toLowerCase().includes(query.toLowerCase())
  ), [secureComparisons, market, side, query]);

  // Candidate list contains *only* live sportsbook lines. Never rank Finder
  // with browser-imported historical game logs; server summaries are authoritative.
  const finderCandidates = useMemo(() => {
    const unique = new Map<string, Prop>();
    for (const p of sportProps) {
      if (p.source !== 'live' || !['draftkings', 'fanduel'].includes(normalizeBook(p.bookmaker))) continue;
      if (market !== 'all' && p.marketKey !== market) continue;
      if (side !== 'all' && p.side !== side) continue;
      if (sportsbook !== 'both' && normalizeBook(p.bookmaker) !== sportsbook) continue;
      if (!`${p.player} ${p.event} ${p.bookmaker}`.toLowerCase().includes(query.toLowerCase())) continue;
      const key = finderTrendKey(p);
      if (!unique.has(key)) unique.set(key, p);
    }
    return [...unique.values()].sort((a, b) => a.player.localeCompare(b.player) || a.marketKey.localeCompare(b.marketKey) || a.line - b.line);
  }, [sportProps, market, side, sportsbook, query]);
  const finderScope = finderCandidates.slice(0, FINDER_MAX_CANDIDATES);
  const finderScopeKey = finderScope.map(finderTrendKey).join(';');

  useEffect(() => {
    if (tab !== 'finder' || !hasPro) {
      setFinderVerified(new Map()); setFinderStatus('idle'); setFinderError(''); setFinderChecked(0);
      return;
    }
    const controller = new AbortController();
    setFinderVerified(new Map()); setFinderError(''); setFinderChecked(0);
    if (!finderScope.length) { setFinderStatus('ready'); return; }
    setFinderStatus('loading');
    const requestedSeason = seasonView === 'all' ? 'all' : seasonFor(sport);
    const snapshot = finderScope.slice();
    void (async () => {
      try {
        const verified = new Map<string, VerifiedTrend>();
        for (let i = 0; i < snapshot.length; i += 20) {
          const group = snapshot.slice(i, i + 20);
          const response = await fetch('/api/history', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ mode: 'trend-summary', sport, season: requestedSeason,
              trends: group.map(p => ({ player: p.player, marketKey: p.marketKey, line: p.line, side: p.side })) })
          });
          const payload = await response.json();
          if (!response.ok) throw Error(typeof payload?.message === 'string' ? payload.message : `Finder request failed (HTTP ${response.status}).`);
          if (!Array.isArray(payload?.trends) || payload.trends.length !== group.length) throw Error('Unexpected Finder response.');
          for (let j = 0; j < group.length; j++) {
            const trend = payload.trends[j] as VerifiedTrend;
            if (!trend || typeof trend.last10?.games !== 'number' || typeof trend.last20?.games !== 'number') throw Error('Invalid server trend data.');
            verified.set(finderTrendKey(group[j]), trend);
          }
          if (!controller.signal.aborted) setFinderChecked(Math.min(snapshot.length, i + group.length));
        }
        if (!controller.signal.aborted) { setFinderVerified(verified); setFinderStatus('ready'); }
      } catch (error) {
        if (!controller.signal.aborted) {
          setFinderVerified(new Map()); setFinderStatus('error');
          setFinderError(error instanceof Error ? error.message : 'Finder history unavailable.');
        }
      }
    })();
    return () => controller.abort();
  // Scope is a stable string of trend keys; changing a prop line changes the request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, hasPro, sport, seasonView, finderScopeKey]);

  const visible = useMemo(() => sportProps
    .filter(p => {
      if (tab === 'finder') {
        if (finderStatus !== 'ready' || p.source !== 'live') return false;
        const summary = finderVerified.get(finderTrendKey(p));
        const sample = finderSample === 20 ? summary?.last20 : summary?.last10;
        return !!sample && sample.games >= finderSample && sample.hitRate !== null && sample.hitRate >= finderThreshold;
      }
      return tab !== 'saved' || isSaved(p, saved);
    })
    .filter(p =>
      (market === 'all' || p.marketKey === market) &&
      (side === 'all' || p.side === side) &&
      (sportsbook === 'both'
        ? ['draftkings', 'fanduel'].includes(normalizeBook(p.bookmaker))
        : normalizeBook(p.bookmaker) === sportsbook) &&
      `${p.player} ${p.event} ${p.bookmaker}`.toLowerCase().includes(query.toLowerCase()) &&
      (tab === 'finder' || minHit === 0 || (p.stats.hit10?.total ?? 0) >= MIN_SAMPLE_FOR_HIGHLIGHT && (p.stats.hit10?.pct ?? -1) >= minHit)
    )
    .map(p => {
      if (tab !== 'finder') return p;
      const summary = finderVerified.get(finderTrendKey(p));
      if (!summary) return p;
      // Finder table values originate from the protected server calculation.
      const rate = (item?: VerifiedTrendSample, n = 10) => item ? {
        hits: item.hits, pushes: item.pushes, total: item.games,
        pct: item.hitRate ?? 0, complete: item.games >= n
      } : null;
      return { ...p, stats: { ...p.stats, hit5: rate(summary.last5, 5),
        hit10: rate(summary.last10, 10), hit20: rate(summary.last20, 20),
        avg: summary.last10.average } };
    })
    .sort((a, b) => {
      const metric = (p: typeof a) => tab === 'finder'
        ? (finderSample === 20 ? p.stats.hit20?.pct : p.stats.hit10?.pct)
        : sortField === 'last5' ? p.stats.hit5?.pct
        : sortField === 'average' ? p.stats.avg : p.stats.hit10?.pct;
      const av = metric(a), bv = metric(b);
      if (av == null && bv == null) return a.player.localeCompare(b.player);
      if (av == null) return 1;
      if (bv == null) return -1;
      return (sortDescending ? bv - av : av - bv) || a.player.localeCompare(b.player);
    }),
    [sportProps, tab, saved, market, side, sportsbook, query, minHit, sortField, sortDescending, finderThreshold, finderSample, finderVerified, finderStatus]
  );

  useEffect(() => { setPage(1); }, [sport, tab, query, market, side, sportsbook, minHit, seasonView, finderThreshold, finderSample]);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const displayed = useMemo(() => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [visible, safePage]);
  // Smart Finder drawer: validate the selected line against server-held history.
  // This call never uses The Odds API. Results are displayed as a separate
  // verification panel until the whole finder is migrated to server execution.
  useEffect(() => {
    if (!selected || tab !== 'finder' || !hasPro || selected.source !== 'live') {
      setVerifiedTrend(null);
      setVerifiedTrendStatus('idle');
      setVerifiedTrendMessage('');
      return;
    }
    const controller = new AbortController();
    setVerifiedTrend(null);
    setVerifiedTrendStatus('loading');
    setVerifiedTrendMessage('');
    const selectedSeason = seasonView === 'all' ? 'all' : seasonFor(selected.sport);
    void (async () => {
      try {
        const response = await fetch('/api/history', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'trend-summary', sport: selected.sport, season: selectedSeason,
            trends: [{ player: selected.player, marketKey: selected.marketKey,
              line: selected.line, side: selected.side }]
          }), signal: controller.signal
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(typeof payload?.message === 'string' ? payload.message : `Verification failed (HTTP ${response.status}).`);
        const trend = payload?.trends?.[0];
        if (!trend || typeof trend.last10?.games !== 'number' || typeof trend.last20?.games !== 'number') {
          throw new Error('Invalid server verification response.');
        }
        if (!controller.signal.aborted) {
          setVerifiedTrend(trend as VerifiedTrend);
          setVerifiedTrendStatus('verified');
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setVerifiedTrendStatus('error');
          setVerifiedTrendMessage(error instanceof Error ? error.message : 'Server verification unavailable.');
        }
      }
    })();
    return () => controller.abort();
  }, [selected, tab, hasPro, seasonView, seasonFor]);

  const selectedStats = useMemo(() => selected ? analyze(selected,
    logIndex.get(`${selected.sport}|${normalize(selected.player)}|${selected.marketKey}`) || [], seasonFor(selected.sport)
  ) : null, [selected, logIndex, seasonFor]);

  const selectedTrends = useMemo(() => selected && selectedStats
    ? recentTrends(selectedStats.games, selected) : null, [selected, selectedStats]);
  // Matchup aggregates come from the verified server, not imported/browser game logs.
  const matchupCandidates = useMemo(() => {
    const seen = new Set<string>();
    return sportProps.filter(p => {
      if (p.source !== 'live' || !['draftkings', 'fanduel'].includes(normalizeBook(p.bookmaker))) return false;
      if (market !== 'all' && p.marketKey !== market) return false;
      if (side !== 'all' && p.side !== side) return false;
      if (sportsbook !== 'both' && normalizeBook(p.bookmaker) !== sportsbook) return false;
      if (!`${p.player} ${p.event} ${p.bookmaker}`.toLowerCase().includes(query.toLowerCase())) return false;
      const key = finderTrendKey(p);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.player.localeCompare(b.player) || a.marketKey.localeCompare(b.marketKey) || a.line - b.line);
  }, [sportProps, market, side, sportsbook, query]);
  const matchupScope = matchupCandidates.slice(0, MATCHUP_MAX_CANDIDATES);
  const matchupScopeKey = matchupScope.map(finderTrendKey).join(';');

  useEffect(() => {
    if (tab !== 'matchups' || !hasPro) {
      setMatchupVerified(new Map()); setMatchupStatus('idle'); setMatchupError('');
      return;
    }
    const controller = new AbortController();
    const snapshot = matchupScope.slice();
    setMatchupVerified(new Map()); setMatchupError('');
    if (!snapshot.length) { setMatchupStatus('ready'); return; }
    setMatchupStatus('loading');
    void (async () => {
      try {
        const verified = new Map<string, MatchupSummary>();
        for (let i = 0; i < snapshot.length; i += 20) {
          const batch = snapshot.slice(i, i + 20);
          const res = await fetch('/api/history', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'matchup-summary', sport,
              season: seasonView === 'all' ? 'all' : seasonFor(sport),
              trends: batch.map(p => ({ player: p.player, marketKey: p.marketKey, line: p.line, side: p.side })) })
          });
          const payload = await res.json();
          if (!res.ok) throw Error(typeof payload?.message === 'string' ? payload.message : `Matchup API error (${res.status}).`);
          if (!Array.isArray(payload?.matchups) || payload.matchups.length !== batch.length) throw Error('Invalid server matchup response.');
          for (let j = 0; j < batch.length; j++) {
            const summary = payload.matchups[j] as MatchupSummary;
            if (typeof summary?.all?.games !== 'number' || !Array.isArray(summary.opponents)) throw Error('Invalid matchup statistics.');
            verified.set(finderTrendKey(batch[j]), summary);
          }
        }
        if (!controller.signal.aborted) { setMatchupVerified(verified); setMatchupStatus('ready'); }
      } catch (error) {
        if (!controller.signal.aborted) {
          setMatchupVerified(new Map()); setMatchupStatus('error');
          setMatchupError(error instanceof Error ? error.message : 'Matchup verification failed.');
        }
      }
    })();
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, hasPro, sport, seasonView, matchupScopeKey]);

  const matchupOpponents = useMemo(() => [...new Set([...matchupVerified.values()].flatMap(item =>
    item.opponents.map(entry => entry.opponent)))].sort(), [matchupVerified]);
  const matchupCards = useMemo(() => {
    if (matchupStatus !== 'ready') return [];
    return matchupScope.flatMap(prop => {
      const summary = matchupVerified.get(finderTrendKey(prop));
      const values = matchupOpponent === 'all' ? summary?.all : summary?.opponents.find(o => o.opponent === matchupOpponent);
      return values && values.games > 0 ? [{ prop, ...values }] : [];
    }).sort((a, b) => b.games - a.games || a.prop.player.localeCompare(b.prop.player));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchupStatus, matchupVerified, matchupOpponent, matchupScopeKey]);

  const comparison = useMemo(() => compareIds.map(id => analyzed.find(p => p.id === id))
    .filter((p): p is (typeof analyzed)[number] => !!p && p.sport === sport), [compareIds, analyzed, sport]);
  const selectedSplits = useMemo(() => selected && selectedStats
    ? splitHistory(selected, selectedStats.games) : null, [selected, selectedStats]);
  const filteredOpponentGames = useMemo(() => !selectedStats ? [] :
    opponentView === 'all' ? selectedStats.games :
    selectedStats.games.filter(g => gameOpponent(g) === opponentView),
    [selectedStats, opponentView]);
  const opponentSummary = useMemo(() => selected && selectedSplits
    ? selectedSplits.summarize(filteredOpponentGames) : null,
    [selected, selectedSplits, filteredOpponentGames]);
  const defenseSeason = selected ? (seasonFor(selected.sport) ?? currentSeason(selected.sport)) : null;
  const defenseTeams = useMemo(() => selected && defenseSeason !== null
    ? defenseRows.filter(r => r.sport === selected.sport && r.season === defenseSeason && r.marketKey === selected.marketKey)
        .map(r => r.team).sort() : [], [selected, defenseSeason, defenseRows]);
  const activeDefenseTeam = defenseTeams.includes(defenseTeam) ? defenseTeam : '';
  const defenseInfo = selected && defenseSeason !== null && activeDefenseTeam
    ? defenseContext(defenseRows, selected.sport, defenseSeason, selected.marketKey, activeDefenseTeam) : null;


  function importDefenseFile(f: File) {
    if (f.size > MAX_CSV_BYTES) { setDefenseError('CSV exceeds the 5 MB import limit.'); return; }
    setDefenseError('');
    if (f.size > 1024 * 1024) { setDefenseError('CSV must be under 1 MB.'); return; }
    void f.text().then(content => {
      const rows = parseDefenseCsv(content);
      setDefenseRows(previous => {
        const incoming = new Set(rows.map(r => `${r.sport}|${r.season}|${r.marketKey}|${normalize(r.team)}`));
        return [...previous.filter(r => !incoming.has(`${r.sport}|${r.season}|${r.marketKey}|${normalize(r.team)}`)), ...rows];
      });
      setNotice(`Imported ${rows.length} source-labeled defensive records. These are not automatically verified.`);
    }).catch(error => setDefenseError(error instanceof Error ? error.message : 'Defensive CSV import failed.'));
  }

  function importFile(f: File) {
    if (f.size > MAX_CSV_BYTES) { setImportError('CSV exceeds the 5 MB import limit.'); return; }
    setImportError('');

    f.text().then(text => {
      try {
        const rows = parseCsv(text);

        if (!rows.length) {
          throw new Error('No valid game log rows found.');
        }

        setLogs(previous => {
          const remaining = previous.filter(existing =>
            !rows.some(row =>
              row.sport === existing.sport &&
              row.player.toLowerCase() === existing.player.toLowerCase() &&
              row.marketKey === existing.marketKey
            )
          );

          return [...remaining, ...rows];
        });

        setNotice(
          `Imported ${rows.length} historical game log rows.`
        );
      } catch (error) {
        setImportError(
          error instanceof Error
            ? error.message
            : 'Invalid CSV file.'
        );
        setNotice('CSV import failed. Check the file format.');
      }
    });
  }

  function addManual(fd: FormData) {
    const sp = fd.get('sport') as Sport;
    const mk = String(fd.get('marketKey'));
    const player = String(fd.get('player')).trim();
    const line = Number(fd.get('line'));
    const odds = Number(fd.get('odds'));

    if (
      !player ||
      !Number.isFinite(line) ||
      !Number.isFinite(odds) ||
      !MARKETS[sp]?.[mk]
    ) return;

    const p: Prop = {
      id: `manual:${Date.now()}`,
      sport: sp,
      player,
      market: MARKETS[sp][mk],
      marketKey: mk,
      line,
      odds,
      side: fd.get('side') as 'Over' | 'Under',
      bookmaker: String(fd.get('bookmaker') || 'Manual'),
      event: String(fd.get('event') || 'Custom matchup'),
      commence: '',
      source: 'manual'
    };

    setProps(previous => [p, ...previous]);
    setSport(sp);
    setSelected(p);
    setModal(false);
  }


  // Only server-verified Elite snapshots may power the paid movement views.
  // Existing legacy browser snapshots are intentionally neither uploaded nor displayed.
  useEffect(() => {
    if (!hasElite || (tab !== 'movement' && tab !== 'dashboard')) {
      setOddsSamples([]); setLineHistoryStatus('idle'); setLineHistoryError('');
      return;
    }
    const controller = new AbortController();
    setOddsSamples([]); setLineHistoryStatus('loading'); setLineHistoryError('');
    void (async () => {
      try {
        const response = await fetch(`/api/research/line-history?sport=${sport}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal
        });
        const data = await response.json() as { samples?: OddsSample[]; error?: string };
        if (!response.ok || !Array.isArray(data.samples)) throw new Error(data.error || 'Line history unavailable.');
        if (!controller.signal.aborted) {
          setOddsSamples(data.samples);
          setLineHistoryStatus('ready');
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setLineHistoryStatus('error');
          setLineHistoryError(error instanceof Error ? error.message : 'Could not verify line history.');
          setOddsSamples([]);
        }
      }
    })();
    return () => controller.abort();
  }, [hasElite, tab, sport, lastUpdated]);

  const movementRows = useMemo(() => {
    const byOffer = new Map<string, OddsSample[]>();
    for (const sample of oddsSamples) {
      if (sample.sport !== sport) continue;
      if (market !== 'all' && sample.marketKey !== market) continue;
      if (side !== 'all' && sample.side !== side) continue;
      if (sportsbook === 'both' ? !['draftkings', 'fanduel'].includes(normalizeBook(sample.bookmaker)) : normalizeBook(sample.bookmaker) !== sportsbook) continue;
      if (!`${sample.player} ${sample.event} ${sample.bookmaker}`.toLowerCase().includes(query.toLowerCase())) continue;
      const key = sampleKey(sample);
      const current = byOffer.get(key) || [];
      current.push(sample); byOffer.set(key, current);
    }
    return [...byOffer.values()].map(samples => {
      const ordered = [...samples].sort((a,b) => a.observedAt.localeCompare(b.observedAt));
      const first = ordered[0], last = ordered[ordered.length - 1];
      return { first, last, count: ordered.length, lineDelta: last.line - first.line,
        oddsDelta: last.odds - first.odds, samples: ordered };
    }).sort((a,b) => b.last.observedAt.localeCompare(a.last.observedAt)).slice(0, 250);
  }, [oddsSamples, sport, market, side, sportsbook, query]);

  // Elite research summaries are calculated from trusted server-side logs and cached odds.
  // Browser-imported history and manual props never influence these Elite rankings.
  useEffect(() => {
    if (tab !== 'dashboard' || !hasElite) {
      setEliteDashboard(null); setEliteDashboardStatus('idle'); setEliteDashboardError('');
      return;
    }
    const controller = new AbortController();
    setEliteDashboard(null); setEliteDashboardStatus('loading'); setEliteDashboardError('');
    void (async () => {
      try {
        const result = await fetch(`/api/research/dashboard?sport=${sport}&season=${seasonView}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal
        });
        const payload = await result.json() as Partial<EliteDashboardData> & { error?: string };
        if (!result.ok || !payload.coverage || !Array.isArray(payload.trends)) {
          throw new Error(payload.error || 'Elite dashboard verification failed.');
        }
        if (!controller.signal.aborted) {
          setEliteDashboard({ coverage: payload.coverage, trends: payload.trends });
          setEliteDashboardStatus('ready');
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setEliteDashboard(null); setEliteDashboardStatus('error');
          setEliteDashboardError(error instanceof Error ? error.message : 'Elite dashboard unavailable.');
        }
      }
    })();
    return () => controller.abort();
  }, [tab, hasElite, sport, seasonView]);
  const dashboardCoverage = eliteDashboard?.coverage ?? { live: 0, uniquePlayers: 0, withHistory: 0, fullTen: 0 };
  const dashboardTrends = eliteDashboard?.trends ?? [];
  const dashboardMovements = useMemo(() => movementRows.filter(row =>
    row.count > 1 && (row.lineDelta !== 0 || row.oddsDelta !== 0)).slice(0,4), [movementRows]);

  return (
    <div className="shell">
      {mobileNavOpen && (
        <button className="mobile-nav-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />
      )}
      <aside className={'sidebar ' + (mobileNavOpen ? 'mobile-open' : '')} aria-label="Main navigation">
        <div className="logo">
          <div className="logo-icon">
            <Activity size={24} />
          </div>
          <div>
            PROP<span>IQ</span>
            <small>THE RESEARCH EDGE</small>
          </div>
        </div>

        <button className="sidebar-close iconbtn" type="button" aria-label="Close menu" onClick={() => setMobileNavOpen(false)}><X size={19} /></button>
        <div className="side-label">WORKSPACE</div>

        <button className={'nav ' + (tab === 'dashboard' ? 'active' : '')} onClick={() => { setTab('dashboard'); setMobileNavOpen(false); }}>
          <Gauge size={18} /> Research Dashboard <span className="tier-nav-label">ELITE</span>
        </button>

        <button
          className={'nav ' + (tab === 'explore' ? 'active' : '')}
          onClick={() => { setTab('explore'); setMobileNavOpen(false); }}
        >
          <LayoutDashboard size={18} />
          Prop Explorer
        </button>

        <button className={'nav ' + (tab === 'finder' ? 'active' : '')} onClick={() => { setTab('finder'); setSortDescending(true); setMobileNavOpen(false); }}>
          <Sparkles size={18} /> Smart Finder <span className="tier-nav-label">PRO</span>
        </button>

        <button className={'nav ' + (tab === 'matchups' ? 'active' : '')} onClick={() => { setTab('matchups'); setMobileNavOpen(false); }}>
          <Shield size={18} /> Matchup Center <span className="tier-nav-label">PRO</span>
        </button>

        <button className={'nav ' + (tab === 'movement' ? 'active' : '')} onClick={() => { setTab('movement'); setMobileNavOpen(false); }}>
          <History size={18} /> Line History <span className="tier-nav-label">ELITE</span>
        </button>

        <button className={'nav ' + (tab === 'odds' ? 'active' : '')} onClick={() => { setTab('odds'); setMobileNavOpen(false); }}>
          <ArrowLeftRight size={18} /> Odds Comparison <span className="tier-nav-label">PRO</span>
        </button>

        <button
          className={'nav ' + (tab === 'saved' ? 'active' : '')}
          onClick={() => { setTab('saved'); setMobileNavOpen(false); }}
        >
          <Bookmark size={18} />
          Saved Props <b>{saved.length || ''}</b>
        </button>

        <div className="side-label spaced">MEMBERSHIP</div>
        <button className="nav" type="button" onClick={() => { setPlansOpen(true); setMobileNavOpen(false); }}>
          <ShieldCheck size={18} /> Membership Plans
        </button>

        <div className="sidebar-bottom">
          <div className="live-dot" />
          <span>Research workspace</span>
          <small>v3.4 · Research dashboard</small>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-leading">
            <button className="mobile-menu-button" type="button" aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}><Menu size={21} /></button>
          <div className="crumb">
            Workspace <span>/</span>{' '}
            {tab === 'dashboard' ? 'Research Dashboard' : tab === 'explore' ? 'Prop Explorer' : tab === 'finder' ? 'Smart Finder' : tab === 'odds' ? 'Odds Comparison' : tab === 'movement' ? 'Line History' : tab === 'matchups' ? 'Matchup Center' : 'Saved Props'}
          </div>
          </div>

          <div className="top-actions">
            <AccountAccess />
            <button type="button" className="top-help" aria-label="Open help and getting started" title="Help & getting started" onClick={() => setHelp(true)}><CircleHelp size={19} /></button>
          </div>
        </header>

        <div className="content premium-content">
          <div className="heading">
            <div>
              <div className="eyebrow">
                <span className="dot" /> YOUR ANALYTICS HUB
              </div>

              <h1>
                {tab === 'dashboard' ? 'Research Dashboard' : tab === 'explore' ? 'Prop Explorer' : tab === 'finder' ? 'Smart Finder' : tab === 'odds' ? 'Odds Comparison' : tab === 'movement' ? 'Line History' : tab === 'matchups' ? 'Matchup Center' : 'Your Watchlist'}
              </h1>

              <p>
                Research live player props, historical results,
                and transparent data coverage.
              </p>
            </div>


          </div>

          <div className="membership-strip" role="status">
            <span>Membership: <strong>{membership === 'loading' ? 'Verifying…' : membership.toUpperCase()}</strong></span>
            {membershipMessage && <span className="membership-strip-warning">{membershipMessage}</span>}
            <button type="button" onClick={() => setPlansOpen(true)}>Compare plans</button>
          </div>

          {lockedTab ? (
            <section className="premium-gate" aria-label="Membership required">
              <ShieldCheck size={28} aria-hidden="true" />
              <span className="eyebrow">{currentRequiredTier?.toUpperCase()} MEMBERSHIP</span>
              <h2>{membership === 'loading' ? 'Verifying your membership…' : `Unlock ${tab === 'dashboard' ? 'Research Dashboard' : tab === 'movement' ? 'Line History' : tab === 'finder' ? 'Smart Finder' : tab === 'odds' ? 'Odds Comparison' : 'Matchup Center'}`}</h2>
              <p>{membership === 'loading' ? 'Checking your account securely.' : `This research tool requires ${currentRequiredTier === 'elite' ? 'Elite' : 'Pro or Elite'} membership. Your access is verified against the Supabase subscription record.`}</p>
              {membership !== 'loading' && <div className="premium-gate-actions">
                <button className="btn" type="button" onClick={() => setPlansOpen(true)}>View membership plans</button>
                <button className="btn secondary" type="button" onClick={() => setTab('explore')}>Use free Prop Explorer</button>
              </div>}
            </section>
          ) : <>

          <div className="sport-tabs">
            <button
              className={sport === 'NBA' ? 'chosen' : ''}
              onClick={() => {
                setSport('NBA');
                setMarket('all');
              }}
            >
              🏀 <span>NBA</span>
            </button>

            <button
              className={sport === 'NFL' ? 'chosen' : ''}
              onClick={() => {
                setSport('NFL');
                setMarket('all');
              }}
            >
              🏈 <span>NFL</span>
            </button>

            <span className="tabs-note">
              Automatically loaded player props
            </span>
          </div>

          <section className="stats-grid" aria-label="Research overview">
            <div className="stat">
              <div className="stat-top">
                AVAILABLE PROPS <BarChart3 size={18} />
              </div>
              <strong>{sportProps.length}</strong>
              <small>Current dataset · {sport}</small>
            </div>

            <div className="stat">
              <div className="stat-top">
                WITH GAME HISTORY <TrendingUp size={18} />
              </div>
              <strong>
                {sportProps.filter(p => p.stats.games.length > 0).length}
              </strong>
              <small>Matching player and stat</small>
            </div>

            <div className="stat">
              <div className="stat-top">
                70%+ LAST 10 <Target size={18} />
              </div>
              <strong>
                {sportProps.filter(p => (p.stats.hit10?.total ?? 0) >= MIN_SAMPLE_FOR_HIGHLIGHT && (p.stats.hit10?.pct ?? 0) >= 70).length}
              </strong>
              <small>10 games required · historical only</small>
            </div>

            <div className="stat">
              <div className="stat-top">
                GAME LOG ROWS <CalendarDays size={18} />
              </div>
              <strong>
                {allLogs.filter(p => p.sport === sport).length}
              </strong>
              <small>Available history rows</small>
            </div>
          </section>

          {lastUpdated && (
            <p className="muted smaller">
              Odds data timestamp: {lastUpdated}
            </p>
          )}



          {tab === 'dashboard' && (
            <section className="command-center" aria-label="Research dashboard">
              <div className="command-heading">
                <div><span className="eyebrow">RESEARCH COMMAND CENTER</span><h2>Everything you need to research {sport}</h2>
                  <p>Observed data from your selected {seasonView === 'all' ? 'all-season' : seasonView} history. No generated picks or predictive probabilities.</p></div>

              </div>
              {eliteDashboardStatus === 'loading' && <p role="status">Verifying Elite research with the server…</p>}
              {eliteDashboardStatus === 'error' && <p role="alert">{eliteDashboardError}</p>}
              <div className="command-metrics">
                <div><span><Database size={15}/> Live offers</span><strong>{dashboardCoverage.live}</strong><small>Live sportsbook offers</small></div>
                <div><span><Activity size={15}/> Players listed</span><strong>{dashboardCoverage.uniquePlayers}</strong><small>Distinct players</small></div>
                <div><span><BarChart3 size={15}/> With history</span><strong>{dashboardCoverage.withHistory}</strong><small>Of {dashboardCoverage.live} live offers</small></div>
                <div><span><ShieldCheck size={15}/> Full L10 samples</span><strong>{dashboardCoverage.fullTen}</strong><small>10 recorded games required</small></div>
              </div>
              <div className="command-grid">
                <div className="command-panel">
                  <div className="command-panel-head"><div><h3>Historical trend watch</h3><p>Highest observed Last 10 hit rates · complete samples</p></div><button onClick={() => setTab('finder')}>Smart Finder <ArrowUpRight size={15}/></button></div>
                  {dashboardTrends.length ? dashboardTrends.map(({prop: p, hits, games, rate}) => (
                    <button className="command-trend-row" key={p.id} onClick={() => setSelected(p)}>
                      <PlayerAvatar name={p.player} {...playerHeadshots.get(`${p.sport}|${normalize(p.player)}`)}/>
                      <span className="command-item-label"><strong>{p.player}</strong><small>{p.side} {p.line} {p.market} · {p.bookmaker}</small></span>
                      <span className="command-rate">{rate}%<small>{hits}/{games}</small></span>
                    </button>
                  )) : <p className="command-empty">{eliteDashboardStatus === 'loading' ? 'Loading verified trends…' : eliteDashboardStatus === 'error' ? 'Verified trends unavailable.' : 'No complete 10-game samples yet. Check your season selection or historical-data coverage.'}</p>}
                </div>
                <div className="command-panel">
                  <div className="command-panel-head"><div><h3>Sportsbook price differences</h3><p>Same player, game, side and exact line</p></div><button onClick={() => setTab('odds')}>Compare <ArrowUpRight size={15}/></button></div>
                  {oddsComparisons.length ? oddsComparisons.slice(0,4).map(({best,other,gain}) => (
                    <button className="command-compare-row" key={best.id} onClick={() => setSelected(best)}>
                      <span className="command-item-label"><strong>{best.player}</strong><small>{best.side} {best.line} {best.market}</small><small>{best.bookmaker} {fmtOdds(best.odds)} vs {other.bookmaker} {fmtOdds(other.odds)}</small></span>
                      <span className="command-gain">+${gain.toFixed(2)}<small>profit / $100</small></span>
                    </button>
                  )) : <p className="command-empty">No exact-line comparisons across both sportsbooks in the current dataset.</p>}
                </div>
                <div className="command-panel">
                  <div className="command-panel-head"><div><h3>Recorded line changes</h3><p>Movement between your saved snapshots</p></div><button onClick={() => setTab('movement')}>Line History <ArrowUpRight size={15}/></button></div>
                  {dashboardMovements.length ? dashboardMovements.map(row => (
                    <div className="command-compare-row" key={sampleKey(row.first)}>
                      <span className="command-item-label"><strong>{row.last.player}</strong><small>{row.last.side} {row.last.market} · {row.last.bookmaker}</small><small>{row.first.line} → {row.last.line} · {fmtOdds(row.first.odds)} → {fmtOdds(row.last.odds)}</small></span>
                      <span className="command-delta">{row.lineDelta > 0 ? '+' : ''}{row.lineDelta.toFixed(1)}<small>line change</small></span>
                    </div>
                  )) : <p className="command-empty">No recorded price or line changes yet. Your daily snapshots only show changes captured between refreshes.</p>}
                </div>
                <div className="command-panel command-actions">
                  <div className="command-panel-head"><div><h3>Quick research tools</h3><p>Continue where you left off</p></div></div>
                  <button onClick={() => setTab('explore')}><Search size={18}/> Browse all player props <ArrowUpRight size={15}/></button>
                  <button onClick={() => setTab('matchups')}><Shield size={18}/> Research opponent matchups <ArrowUpRight size={15}/></button>
                  <button onClick={() => setTab('saved')}><Bookmark size={18}/> View your saved props <ArrowUpRight size={15}/></button>
                  <div className="command-note"><ShieldCheck size={16}/><span>Historical records can be incomplete. Sportsbook prices may be stale, and no statistical trend guarantees a future outcome.</span></div>
                </div>
              </div>
            </section>
          )}

          {tab !== 'dashboard' && (
            <>
          <div className="section-title premium-section-title">
            <div>
              <div className="eyebrow">RESEARCH DESK</div>
              {tab === 'saved' && cloudMessage && <p className="muted smaller" role="status">Cloud sync: {cloudMessage}</p>}
              <h2>{tab === 'saved' ? 'Saved player props' : tab === 'finder' ? 'Historical trend finder' : tab === 'odds' ? 'Compare sportsbook prices' : tab === 'movement' ? 'Line movement & odds history' : tab === 'matchups' ? 'Opponent matchup research' : 'Explore player props'}</h2>
              <p>
                {tab === 'finder' ? 'Screen live player props by completed historical samples. These are past results, not win probabilities or betting recommendations.' : tab === 'odds' ? 'Compare the exact same live player prop across DraftKings and FanDuel. Better prices increase potential payout, not the chance of winning.' : tab === 'movement' ? 'Track actual changes between recorded sportsbook snapshots. Daily refresh means movements between snapshots are not captured.' : tab === 'matchups' ? 'Compare recorded player results against an opponent. Select a team using historical game logs; no projected matchup is assumed.' : 'Click Last 5, Last 10, or L10 AVG to sort player props. Click a prop for a game-by-game breakdown.'}
              </p>
            </div>

            <span className="results">
              {tab === 'odds' ? oddsComparisons.length : tab === 'movement' ? movementRows.length : tab === 'matchups' ? matchupCards.length : visible.length} results
            </span>
          </div>

          {tab === 'finder' && (
            <section className="finder-panel" aria-label="Smart Finder research controls">
              <div className="finder-intro">
                <span className="finder-icon"><Sparkles size={20}/></span>
                <div><strong>Smart Finder · Historical trends</strong><p>Only live sportsbook props with a complete game sample qualify. Results follow your selected season, sportsbook, and other filters.</p></div>
              </div>
              <div className="finder-controls">
                <label>Historical sample
                  <select value={finderSample} onChange={e => setFinderSample(Number(e.target.value) as 10 | 20)}>
                    <option value={10}>Last 10 games</option>
                    <option value={20}>Last 20 games</option>
                  </select>
                </label>
                <label>Minimum observed hit rate
                  <select value={finderThreshold} onChange={e => setFinderThreshold(Number(e.target.value))}>
                    <option value={50}>50% or higher</option>
                    <option value={60}>60% or higher</option>
                    <option value={70}>70% or higher</option>
                    <option value={80}>80% or higher</option>
                    <option value={90}>90% or higher</option>
                  </select>
                </label>
                <div className="finder-count"><strong>{visible.length}</strong><span>server-verified matches</span></div>
              </div>
              <p className="finder-disclaimer" role="status"><ShieldCheck size={14}/>
                {finderStatus === 'loading' ? `Verifying trends on the server: ${finderChecked}/${finderScope.length} checked…` :
                 finderStatus === 'error' ? `Server research unavailable: ${finderError}` :
                 `Server-verified research across ${finderScope.length} candidate lines. ${finderCandidates.length > FINDER_MAX_CANDIDATES ? `Limited to the first ${FINDER_MAX_CANDIDATES} of ${finderCandidates.length} candidates; narrow your search or market to see more.` : ''} Historical hit rates are not future probabilities.`}
              </p>
            </section>
          )}
          <div className="research-toolbar">
            <span><SlidersHorizontal size={15} /> Research filters</span>
            <button type="button" className="reset-filters" onClick={() => { setQuery(''); setMarket('all'); setSide('all'); setMinHit(0); setSportsbook('both'); setSeasonView('current'); }}>Reset filters</button>
          </div>
          <div className="filters">
            <label className="select-wrap">
              <CalendarDays size={16} />
              <select aria-label="Historical season" value={seasonView}
                onChange={e => setSeasonView(e.target.value as 'current' | 'previous' | 'all')}>
                <option value="current">Season {seasonLabel(sport, currentSeason(sport))}</option>
                <option value="previous">Season {seasonLabel(sport, currentSeason(sport) - 1)}</option>
                <option value="all">All available seasons</option>
              </select>
              <ChevronDown size={15} />
            </label>
            <label className="select-wrap">
              <Filter size={16} />
              <select
                aria-label="Sportsbook"
                value={sportsbook}
                onChange={e => setSportsbook(e.target.value as SportsbookFilter)}
              >
                <option value="both">DraftKings + FanDuel</option>
                <option value="draftkings">DraftKings only</option>
                <option value="fanduel">FanDuel only</option>
              </select>
              <ChevronDown size={15} />
            </label>
            <label className="search">
              <Search size={18} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search players, games, sportsbooks..."
              />
            </label>

            <label className="select-wrap">
              <Filter size={16} />
              <select
                value={market}
                onChange={e => setMarket(e.target.value)}
              >
                <option value="all">All markets</option>
                {Object.entries(MARKETS[sport]).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <ChevronDown size={15} />
            </label>

            <label className="select-wrap">
              <ArrowDownUp size={16} />
              <select
                value={side}
                onChange={e => setSide(e.target.value)}
              >
                <option value="all">Over / Under</option>
                <option>Over</option>
                <option>Under</option>
              </select>
              <ChevronDown size={15} />
            </label>

            <label className="select-wrap">
              <SlidersHorizontal size={16} />
              <select
                value={minHit}
                onChange={e => setMinHit(Number(e.target.value))}
              >
                <option value={0}>Any hit rate</option>
                <option value={50}>50%+ last 10</option>
                <option value={70}>70%+ last 10</option>
                <option value={80}>80%+ last 10</option>
              </select>
              <ChevronDown size={15} />
            </label>
          </div>

          <p className="season-coverage">Historical filter: <strong>{seasonView === 'all' ? 'All available seasons' : seasonLabel(sport, seasonFor(sport)!)}</strong> · {seasonAvailable} matching statistic observations available. A missing result means missing coverage, not a 0% chance.</p>
          {sportProps.length > 0 && seasonAvailable === 0 && !historyLoading && (
            <div className="history-alert" role="alert">
              <strong>No {seasonView === 'all' ? '' : `${seasonLabel(sport, seasonFor(sport)!)} `}{sport} game logs available for these props.</strong>
              <p>The sportsbook lines are working. Historical player stats are a separate feed, and this season currently has no matching records. Hit rates cannot be calculated until valid game logs load.</p>
              <p className="history-alert-reason">{historyStatus}</p>
              {historyDiagnostics.length > 0 && <details><summary>History source diagnostics</summary><ul>{historyDiagnostics.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
              <div className="history-alert-actions">
                {seasonView === 'current' && <button className="btn secondary" onClick={() => setSeasonView('previous')}>Check previous season</button>}
                <button className="btn secondary" onClick={() => file.current?.click()}><FileUp size={15}/> Import game logs</button>
              </div>
            </div>
          )}
          {tab === 'movement' ? (
            <section className="line-history-section" aria-label="Recorded sportsbook line movement">
              <div className="line-history-intro">
                <History size={19}/>
                <div><strong>Recorded odds snapshots</strong>
                <p>Saved on the secure Railway volume when an Elite user opens this view and a newer cached provider timestamp is available. Up to 30 days of observations (maximum 12,000 records). Earlier movements cannot be reconstructed.</p></div>
              </div>
              {lineHistoryStatus === 'loading' && <p role="status">Loading Elite line history…</p>}
              {lineHistoryStatus === 'error' && <p className="history-alert" role="alert">{lineHistoryError}</p>}
              {lineHistoryStatus === 'ready' && movementRows.length ? (
                <div className="line-history-table-wrap"><table className="line-history-table"><thead><tr><th>PLAYER / MATCHUP</th><th>MARKET</th><th>FIRST RECORDED</th><th>LATEST RECORDED</th><th>LINE CHANGE</th><th>ODDS CHANGE</th><th>SAMPLES</th></tr></thead><tbody>
                  {movementRows.map(({first,last,lineDelta,oddsDelta,count}) => (
                    <tr key={sampleKey(last)}>
                      <td><strong>{last.player}</strong><small>{last.event} · {last.bookmaker}</small></td>
                      <td>{last.side} {last.market}</td>
                      <td>{first.line} ({fmtOdds(first.odds)})<small>{new Date(first.observedAt).toLocaleString()}</small></td>
                      <td>{last.line} ({fmtOdds(last.odds)})<small>{new Date(last.observedAt).toLocaleString()}</small></td>
                      <td className={lineDelta === 0 ? 'movement-flat' : 'movement-change'}>{lineDelta > 0 ? '+' : ''}{lineDelta.toFixed(1)}</td>
                      <td className={oddsDelta === 0 ? 'movement-flat' : 'movement-change'}>{oddsDelta > 0 ? '+' : ''}{oddsDelta}</td>
                      <td>{count}{count === 1 ? <small>Baseline only</small> : null}</td>
                    </tr>
                  ))}
                </tbody></table></div>
              ) : lineHistoryStatus === 'ready' ? <div className="empty"><History size={28}/><h3>No line history recorded yet</h3><p>The first Elite request stores a baseline from the latest cached odds. A later, newly timestamped provider snapshot is needed to show movement.</p></div> : null}
              <p className="finder-disclaimer"><ShieldCheck size={14}/> Server-stored snapshots are shared across your Elite sessions, and only Elite accounts can request them. Older browser-only snapshots are not migrated. Not a real-time line movement feed.</p>
            </section>
          ) : tab === 'matchups' ? (
            <section className="matchup-center" aria-label="Player matchup research">
              <div className="matchup-center-controls">
                <div>
                  <h3><Shield size={19}/> Matchup Intelligence</h3>
                  <p>Choose an opponent from recorded game logs. The displayed percentages describe past games only; opponent sample sizes can be small.</p>
                </div>
                <label>Recorded opponent
                  <select value={matchupOpponents.includes(matchupOpponent) ? matchupOpponent : 'all'}
                    onChange={e => setMatchupOpponent(e.target.value)}>
                    <option value="all">All recorded opponents</option>
                    {matchupOpponents.map(team => <option key={team} value={team}>{team}</option>)}
                  </select>
                </label>
              </div>
              {matchupStatus === 'loading' && <p className="finder-disclaimer">Verifying opponent records on the server…</p>}
              {matchupStatus === 'error' && <p role="alert" className="finder-disclaimer">Server matchup research unavailable: {matchupError}</p>}
              {matchupStatus === 'ready' && matchupCandidates.length > MATCHUP_MAX_CANDIDATES &&
                <p className="finder-disclaimer">Showing the first {MATCHUP_MAX_CANDIDATES} candidate props. Narrow the filters to research more.</p>}
              {matchupStatus === 'ready' && matchupCards.length ? (
                <div className="matchup-center-grid">
                  {matchupCards.slice(0, 80).map(({prop, games, hits, pushes, average}) => (
                    <article className="matchup-center-card" key={prop.id}>
                      <div className="matchup-center-person">
                        <PlayerAvatar name={prop.player} {...playerHeadshots.get(`${prop.sport}|${normalize(prop.player)}`)}/>
                        <div><strong>{prop.player}</strong><small>{prop.event}</small></div>
                      </div>
                      <div className="matchup-center-prop"><Pill kind={prop.side === 'Over' ? 'green' : 'purple'}>{prop.side}</Pill> {prop.line} {prop.market}</div>
                      <div className="matchup-center-metrics">
                        <div><small>RECORDED GAMES</small><strong>{games}</strong></div>
                        <div><small>OBSERVED HITS</small><strong>{hits}/{games}</strong></div>
                        <div><small>AVERAGE</small><strong>{average === null ? '—' : average.toFixed(1)}</strong></div>
                      </div>
                      <p>{Math.round(100 * hits / games)}% historical hit rate · {pushes} push{pushes === 1 ? '' : 'es'} · {matchupOpponent === 'all' ? 'All opponents' : `vs ${matchupOpponent}`} · {prop.bookmaker}</p>
                      <button type="button" className="odds-view-research" onClick={() => {setSelected(prop); setOpponentView(matchupOpponent);}}>
                        Open full matchup research
                      </button>
                    </article>
                  ))}
                </div>
              ) : matchupStatus === 'ready' ? <div className="empty"><h3>No recorded matchups found</h3><p>Try another opponent or season. If game logs are missing, the historical feed must be restored first.</p></div> : null}
              {matchupCards.length > 80 && <p className="muted smaller">Showing 80 matching props. Use search or market filters to narrow results.</p>}
              <p className="finder-disclaimer"><ShieldCheck size={14}/> Server-verified results describe historical games, not a forecast. Current opponent is not inferred from event titles. Team defense rankings require the optional sourced CSV import.</p>
            </section>
          ) : tab === 'odds' ? (
            <section className="odds-compare-area" aria-label="Sportsbook odds comparison">
              <div className="odds-compare-note"><ArrowLeftRight size={18}/>
                <span>Showing <strong>{oddsComparisons.length}</strong> exact-line matches across DraftKings and FanDuel. Both books are shown regardless of the sportsbook filter. $100 profit figures exclude the returned stake and any fees. Odds can change at any time.</span>
              </div>
              {oddsComparisons.length ? (
                <div className="odds-compare-grid">
                  {oddsComparisons.slice(0, 100).map(({ best, other, gain }) => (
                    <article className="odds-compare-card" key={best.id + other.id}>
                      <div className="odds-compare-player">
                        <PlayerAvatar name={best.player} {...playerHeadshots.get(`${best.sport}|${normalize(best.player)}`)}/>
                        <div><strong>{best.player}</strong><small>{best.event}</small></div>
                      </div>
                      <div className="odds-compare-line"><Pill kind={best.side === 'Over' ? 'green' : 'purple'}>{best.side}</Pill> {best.line} {best.market}</div>
                      <div className="odds-offers">
                        {[best, other].map((offer, index) => (
                          <div className={'odds-offer ' + (index === 0 ? 'best' : '')} key={offer.id}>
                            <span>{offer.bookmaker}{index === 0 && <b>BEST PRICE</b>}</span>
                            <strong>{fmtOdds(offer.odds)}</strong>
                            <small>${profitOn100(offer.odds).toFixed(2)} profit / $100 stake</small>
                          </div>
                        ))}
                      </div>
                      <div className="odds-difference"><span>Additional potential profit at best price</span><strong>+${gain.toFixed(2)}</strong></div>
                      <button className="odds-view-research" type="button" onClick={() => {setSelected(best);setOpponentView('all');}}>View player research</button>
                    </article>
                  ))}
                </div>
              ) : <div className="empty"><h3>{comparisonStatus === 'loading' ? 'Verifying sportsbook prices…' : comparisonStatus === 'error' ? 'Verified comparison unavailable' : 'No matching prices at identical lines'}</h3><p>{comparisonStatus === 'loading' ? 'Calculating exact-line differences on the protected server.' : comparisonStatus === 'error' ? comparisonError : 'Both sportsbooks must offer the same player, game, market, direction, and line. Try resetting market and direction filters or refreshing live odds.'}</p></div>}
              {oddsComparisons.length > 100 && <p className="muted smaller">Showing the 100 largest differences. Narrow your search to see other comparisons.</p>}
            </section>
          ) : (<>
          <div className="table-summary">
            <span><strong>{visible.length.toLocaleString()}</strong> matching props <span className="summary-separator">·</span> {sport} <span className="summary-separator">·</span> {seasonView === 'all' ? 'All seasons' : `Season ${seasonLabel(sport, seasonFor(sport)!)}`}</span>
            <span className="table-summary-hint">Select a row to open player research</span>
          </div>
          <div className="table-card premium-table">
            <div className="scroll-table">
              <table>
                <thead>
                  <tr>
                    <th>PLAYER / MATCHUP</th>
                    <th>PROP LINE</th>
                    <th><button type="button" className={"sort-header " + (sortField === "last5" ? "sort-active" : "")} onClick={() => { setSortField("last5"); setSortDescending(sortField === "last5" ? !sortDescending : true); setPage(1); }}>LAST 5 {sortField === "last5" ? (sortDescending ? "↓" : "↑") : "↕"}</button></th>
                    <th><button type="button" className={"sort-header " + (sortField === "last10" ? "sort-active" : "")} onClick={() => { setSortField("last10"); setSortDescending(sortField === "last10" ? !sortDescending : true); setPage(1); }}>LAST 10 {sortField === "last10" ? (sortDescending ? "↓" : "↑") : "↕"}</button></th>
                    <th><button type="button" className={"sort-header " + (sortField === "average" ? "sort-active" : "")} onClick={() => { setSortField("average"); setSortDescending(sortField === "average" ? !sortDescending : true); setPage(1); }}>L10 AVG {sortField === "average" ? (sortDescending ? "↓" : "↑") : "↕"}</button></th>
                    <th>BOOK / ODDS</th>
                    <th>DATA</th>
                    <th>COMPARE</th>
                    <th></th>
                  </tr>
                </thead>

                <tbody>
                  {displayed.map(({ stats, ...p }) => (
                    <tr
                      key={p.id}
                      onClick={() => { setSelected(p); setOpponentView('all'); }}
                    >
                      <td>
                        <div className="player-identity">
                          <PlayerAvatar name={p.player} {...playerHeadshots.get(`${p.sport}|${normalize(p.player)}`)} />
                          <div className="player-identity-text">
                            <div className="player-name">{p.player}</div>
                            <div className="muted smaller">{p.event}</div>
                          </div>
                        </div>
                      </td>

                      <td>
                        <div className="line">
                          <Pill kind={
                            p.side === 'Over' ? 'green' : 'purple'
                          }>
                            {p.side}
                          </Pill>
                          {' '}{p.line} {p.market}
                        </div>
                      </td>

                      <td>
                        <Rate rate={stats.hit5?.pct} />
                        <small className="muted">
                          {stats.hit5
                            ? `${stats.hit5.hits}/${stats.hit5.total}${stats.hit5.complete ? '' : ' · partial'}`
                            : 'No history'}
                        </small>
                      </td>

                      <td>
                        <Rate rate={stats.hit10?.pct} />
                        <small className="muted">
                          {stats.hit10
                            ? `${stats.hit10.hits}/${stats.hit10.total}${stats.hit10.complete ? '' : ' · partial'}`
                            : 'No history'}
                        </small>
                      </td>

                      <td className="num">
                        {stats.avg?.toFixed(1) ?? '—'}
                      </td>

                      <td>
                        <b className="odds">{fmtOdds(p.odds)}</b>
                        <small className="muted">{p.bookmaker}</small>
                      </td>

                      <td>
                        <Pill kind={
                          p.source === 'live'
                            ? 'blue'
                            : p.source === 'manual'
                              ? 'purple'
                              : 'amber'
                        }>
                          {p.source.toUpperCase()}
                        </Pill>
                      </td>

                      <td>
                        <button type="button" className={'compare-toggle ' + (compareIds.includes(p.id) ? 'on' : '')}
                          aria-label={`${compareIds.includes(p.id) ? 'Remove' : 'Add'} ${p.player} ${p.market} ${p.side} from comparison`}
                          aria-pressed={compareIds.includes(p.id)}
                          onClick={e => {
                            e.stopPropagation();
                            setCompareIds(prev => prev.includes(p.id) ? prev.filter(id => id !== p.id) : [...prev.slice(-1), p.id]);
                          }}>{compareIds.includes(p.id) ? 'Selected' : 'Compare'}</button>
                      </td>
                      <td>
                        <button
                          className={
                            'bookmark ' +
                            (isSaved(p, saved) ? 'saved' : '')
                          }
                          onClick={e => {
                            e.stopPropagation();
                            if (cloudAccount && !cloudReady) return;
                            setSaved(previous =>
                              isSaved(p, previous)
                                ? previous.filter(id => id !== p.id && id !== bookmarkKey(p))
                                : [...previous, bookmarkKey(p)]
                            );
                          }}
                        >
                          <Bookmark
                            size={17}
                            fill={
                              isSaved(p, saved)
                                ? 'currentColor'
                                : 'none'
                            }
                          />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {visible.length === 0 && (
              <div className="empty">
                <Search size={28} />
                <h3>
                  {loading ? 'Loading player props...' : tab === 'finder' && finderStatus === 'loading' ? 'Checking verified player trends...' : tab === 'finder' && finderStatus === 'error' ? 'Verified research unavailable' : tab === 'finder' ? 'No qualifying trends' : sportProps.length === 0 ? `No ${sport} sportsbook props available` : 'No props match these filters'}
                </h3>
                <p>
                  {loading
                    ? 'Checking available sportsbook lines.'
                    : tab === 'finder' ? (finderStatus === 'error' ? finderError : finderStatus === 'loading' ? 'Server calculations are being checked.' : 'Try a lower hit-rate threshold, a different season, or Last 10. Missing history is not a missed bet.') : sportProps.length === 0 ? (notice || 'Sportsbooks may not have posted these player markets yet. Try refreshing nearer to kickoff; provider errors appear above.') : 'Try another filter, reset filters, or refresh live odds.'}
                </p>
              </div>
            )}
          </div>

          </>)}
          {tab !== 'odds' && tab !== 'matchups' && tab !== 'movement' && comparison.length > 0 && (
            <section className="comparison-panel" aria-label="Selected prop comparison">
              <div className="comparison-head">
                <div><h2>Compare player props ({comparison.length}/2)</h2>
                  <p>Side-by-side historical research for the selected season. Different markets may use different units.</p></div>
                <button className="btn secondary" type="button" onClick={() => setCompareIds([])}>Clear comparison</button>
              </div>
              <div className="comparison-grid">
                {comparison.map(p => {
                  const trends = recentTrends(p.stats.games, p);
                  return <div className="comparison-card" key={p.id}>
                    <div className="comparison-name"><strong>{p.player}</strong>
                      <button className="iconbtn" type="button" onClick={() => setCompareIds(ids => ids.filter(id => id !== p.id))} aria-label={`Remove ${p.player}`}><X size={16}/></button></div>
                    <p>{p.side} {p.line} {p.market} · {p.bookmaker} ({fmtOdds(p.odds)})</p>
                    <dl>
                      <div><dt>Games recorded</dt><dd>{p.stats.games.length}</dd></div>
                      <div><dt>Last 5 hits</dt><dd>{p.stats.hit5 ? `${p.stats.hit5.hits}/${p.stats.hit5.total}` : '—'}</dd></div>
                      <div><dt>Last 10 hits</dt><dd>{p.stats.hit10 ? `${p.stats.hit10.hits}/${p.stats.hit10.total}` : '—'}</dd></div>
                      <div><dt>Last 10 average</dt><dd>{p.stats.avg?.toFixed(1) ?? '—'}</dd></div>
                      <div><dt>Last 10 median</dt><dd>{trends.median?.toFixed(1) ?? '—'}</dd></div>
                      <div><dt>Last 5 vs prior 5</dt><dd>{trends.averageChange === null ? 'Need 10 games' : `${trends.averageChange >= 0 ? '+' : ''}${trends.averageChange.toFixed(1)}`}</dd></div>
                    </dl>
                  </div>;
                })}
              </div>
              <small>These are observed results, not projected probabilities or a recommendation. Comparison clears if live lines change or disappear.</small>
            </section>
          )}

          {tab !== 'odds' && visible.length > PAGE_SIZE && (
            <div className="heading-actions" style={{ justifyContent: 'center', marginTop: 16, marginBottom: 16 }}>
              <button className="btn secondary" disabled={safePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                Previous
              </button>
              <span className="muted smaller" style={{ alignSelf: 'center' }}>
                Page {safePage} of {totalPages} · Showing {displayed.length} of {visible.length}
              </span>
              <button className="btn secondary" disabled={safePage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                Next
              </button>
            </div>
          )}

            </>
          )}

          {defenseError && <p className="defense-error" role="alert">Defense CSV: {defenseError}</p>}

          <div className="footer-tip">
            <ShieldCheck size={18} />
            <span>
              <strong>Research, not guarantees.</strong>
              {' '}Historical hit rates are observations, not
              calibrated probabilities. Sportsbook odds can change.
              Missing game logs do not mean a 0% chance of hitting. Partial samples and pushes can affect rates.
            </span>
          </div>
          </>}
        </div>
      </main>

      <input ref={defenseFile} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) importDefenseFile(f); e.target.value = ''; }} />
      <input
        ref={file}
        style={{ display: 'none' }}
        type="file"
        accept=".csv,text/csv"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) importFile(f);
          e.target.value = '';
        }}
      />

      {selected && selectedStats && (
        <div className="overlay" onClick={() => setSelected(null)}>
          <aside
            className="drawer"
            onClick={e => e.stopPropagation()}
          >
            <div className="drawer-head">
              <div className="drawer-player-identity">
                <PlayerAvatar name={selected.player} size="large" {...playerHeadshots.get(`${selected.sport}|${normalize(selected.player)}`)} />
                <div>
                  <span className="eyebrow">PLAYER RESEARCH</span>
                  <h2>{selected.player}</h2>
                  <p>{selected.event}</p>
                </div>
              </div>

              <button
                className="iconbtn"
                onClick={() => setSelected(null)}
              >
                <X size={20} />
              </button>
            </div>

            <div className="hero-prop">
              <div>
                <span>YOUR SELECTED PROP</span>
                <h3>
                  {selected.side} {selected.line} {selected.market}
                </h3>
                <small>
                  {selected.bookmaker} · {fmtOdds(selected.odds)} ·{' '}
                  {selected.source.toUpperCase()}
                </small>
              </div>
              <Target size={28} />
            </div>

            {tab === 'finder' && selected.source === 'live' && (
              <section className="verified-trend-panel" aria-live="polite">
                <strong><ShieldCheck size={16} /> Server-verified Smart Finder result</strong>
                {verifiedTrendStatus === 'loading' && <p>Checking this prop against server-side game logs…</p>}
                {verifiedTrendStatus === 'error' && <p>Verification unavailable: {verifiedTrendMessage}. Browser values are not verified.</p>}
                {verifiedTrendStatus === 'verified' && verifiedTrend && (
                  <div className="verified-trend-grid">
                    <div><small>LAST 10 · SERVER</small><b>{verifiedTrend.last10.hitRate === null ? '—' : `${verifiedTrend.last10.hitRate}%`}</b>
                      <span>{verifiedTrend.last10.hits}/{verifiedTrend.last10.games} hits{verifiedTrend.last10.games < 10 ? ' · partial' : ''}</span></div>
                    <div><small>LAST 20 · SERVER</small><b>{verifiedTrend.last20.hitRate === null ? '—' : `${verifiedTrend.last20.hitRate}%`}</b>
                      <span>{verifiedTrend.last20.hits}/{verifiedTrend.last20.games} hits{verifiedTrend.last20.games < 20 ? ' · partial' : ''}</span></div>
                  </div>
                )}
                <small>Historical observations, not predicted win probabilities. Finder list rankings are still calculated in the browser.</small>
              </section>
            )}

            <div className="season-summary">
              <strong>{seasonView === 'all' ? 'All available seasons' : `Season ${seasonLabel(selected.sport, seasonFor(selected.sport)!)}`}</strong>
              <span>{selectedStats.games.length} recorded games · {selectedStats.avg === null ? 'No average available' : `${selectedStats.avg.toFixed(1)} average (${Math.min(10, selectedStats.games.length)} most recent)`}</span>
              <span>At this line: {selectedStats.season ? `${selectedStats.season.hits}/${selectedStats.season.total} hits (${selectedStats.season.pct}%)` : 'No matching history'}</span>
            </div>
            {selectedTrends && <section className="trend-research">
              <div className="drawer-sub"><strong>Advanced Recent Trends</strong>
                <small>Actual recorded games in the selected season; missing samples are not estimated.</small></div>
              <div className="trend-grid">
                <div><small>LAST 5 AVG</small><strong>{selectedTrends.recentAverage?.toFixed(1) ?? '—'}</strong></div>
                <div><small>PREVIOUS 5 AVG</small><strong>{selectedTrends.previousAverage?.toFixed(1) ?? '—'}</strong></div>
                <div><small>AVERAGE CHANGE</small><strong>{selectedTrends.averageChange === null ? '—' : `${selectedTrends.averageChange >= 0 ? '+' : ''}${selectedTrends.averageChange.toFixed(1)}`}</strong></div>
                <div><small>LAST 10 MEDIAN</small><strong>{selectedTrends.median?.toFixed(1) ?? '—'}</strong></div>
                <div><small>LAST 10 RANGE</small><strong>{selectedTrends.range ? `${selectedTrends.range.min}–${selectedTrends.range.max}` : '—'}</strong></div>
                <div><small>CURRENT STREAK</small><strong>{selectedTrends.currentStreak.length ? `${selectedTrends.currentStreak.length} ${selectedTrends.currentStreak.kind.toUpperCase()}` : '—'}</strong></div>
              </div>
              <p className="split-note">Change requires two complete sets of five games. A streak counts consecutive recorded games at this exact line; it does not predict the next game.</p>
            </section>}
            {selectedSplits && <section className="matchup-research">
              <div className="drawer-sub">
                <strong>Home / Away Splits</strong>
                <small>Only games with confirmed location metadata are included. These are historical results, not projections.</small>
              </div>
              <div className="split-grid">
                {([['HOME', selectedSplits.home], ['AWAY', selectedSplits.away]] as const).map(([name, summary]) => (
                  <div className="split-card" key={name}>
                    <small>{name} · {summary.games} games</small>
                    <b>{summary.pct === null ? '—' : `${summary.pct}%`}</b>
                    <span>{summary.games ? `${summary.hits}/${summary.games} hits · ${summary.average?.toFixed(1)} avg` : 'No verified venue data'}</span>
                  </div>
                ))}
              </div>
              {selectedSplits.unknownVenue > 0 &&
                <p className="split-note">{selectedSplits.unknownVenue} games excluded from venue splits because home/away is unknown.</p>}
              <div className="drawer-sub">
                <strong>Opponent Matchup History</strong>
                <small>Filter recorded games by opponent. Select an opponent to view past results against that team.</small>
              </div>
              <label className="matchup-select-label">Opponent
                <select className="matchup-select" value={selectedSplits.opponents.includes(opponentView) ? opponentView : 'all'}
                  onChange={e => setOpponentView(e.target.value)}>
                  <option value="all">All opponents</option>
                  {selectedSplits.opponents.map(team => <option key={team} value={team}>{team}</option>)}
                </select>
              </label>
              {opponentSummary && <div className="opponent-summary">
                <span><strong>{opponentSummary.games}</strong> games</span>
                <span><strong>{opponentSummary.pct === null ? '—' : `${opponentSummary.pct}%`}</strong> hit rate</span>
                <span><strong>{opponentSummary.average === null ? '—' : opponentSummary.average.toFixed(1)}</strong> average</span>
              </div>}
              {selectedSplits.opponents.length === 0 && <p className="split-note">Opponent information is not available for these records.</p>}
              <div className="drawer-sub">
                <strong>Opponent Defensive Rankings</strong>
                <small>Choose an imported opponent; league ranks require all {selected.sport === 'NBA' ? 30 : 32} teams for this market and season.</small>
                <button type="button" className="btn secondary" onClick={() => defenseFile.current?.click()}><FileUp size={15} /> Import defense data</button>
              </div>
              <label className="matchup-select-label">Defensive opponent ({defenseSeason === null ? 'unknown season' : seasonLabel(selected.sport, defenseSeason)})
                <select className="matchup-select" value={activeDefenseTeam} onChange={e => setDefenseTeam(e.target.value)}>
                  <option value="">Select imported team</option>
                  {defenseTeams.map(team => <option key={team} value={team}>{team}</option>)}
                </select>
              </label>
              {defenseInfo?.selected ? <div className="defense-panel">
                <div className="defense-metrics">
                  <span><small>ALLOWED / GAME</small><strong>{defenseInfo.selected.allowedPerGame.toFixed(1)}</strong></span>
                  <span><small>DEFENSE RANK (FEWEST = #1)</small><strong>{defenseInfo.rank === null ? '—' : `#${defenseInfo.rank} / ${defenseInfo.expected}`}</strong></span>
                  <span><small>TEAM GAMES</small><strong>{defenseInfo.selected.games}</strong></span>
                </div>
                <p>Source: {defenseInfo.selected.source} · {defenseInfo.coverage}/{defenseInfo.expected} teams represented.</p>
                {!defenseInfo.completeLeague && <p>League ranking unavailable until a complete set of teams is imported for this exact market and season.</p>}
              </div> : <p className="split-note">{defenseTeams.length ? 'Select a team to review imported defensive statistics.' : 'No imported defensive data for this market and season. Use Import defense data to add records.'}</p>}
              <p className="split-note">Allowed-per-game data is descriptive team-level context, not a prediction of this player's performance. Imported sources have not been independently verified by PropIQ.</p>
            </section>}
            <div className="drawer-stats">
              <div>
                <small>LAST 5</small>
                <b>{pct(selectedStats.hit5?.pct)}</b>
                <span>
                  {selectedStats.hit5
                    ? `${selectedStats.hit5.hits} of ${selectedStats.hit5.total}${selectedStats.hit5.complete ? '' : ' · partial'}`
                    : 'No history'}
                </span>
              </div>

              <div>
                <small>LAST 10</small>
                <b>{pct(selectedStats.hit10?.pct)}</b>
                <span>
                  {selectedStats.hit10
                    ? `${selectedStats.hit10.hits} of ${selectedStats.hit10.total}${selectedStats.hit10.complete ? '' : ' · partial'}`
                    : 'No history'}
                </span>
              </div>

              <div>
                <small>LAST 20</small>
                <b>{pct(selectedStats.hit20?.pct)}</b>
                <span>
                  {selectedStats.hit20
                    ? `${selectedStats.hit20.hits} of ${selectedStats.hit20.total}${selectedStats.hit20.complete ? '' : ' · partial'}`
                    : 'No history'}
                </span>
              </div>
            </div>

            <div className="drawer-sub">
              <strong>{opponentView === 'all' ? 'Last 10 games' : `Last 10 vs ${opponentView}`} · {seasonView === 'all' ? 'all seasons' : seasonLabel(selected.sport, seasonFor(selected.sport)! )}</strong>
              <small>
                Line: {selected.line} · green = hit · red = miss
                · gray = push
              </small>
            </div>

            {filteredOpponentGames.length ? (
              <>
                <div className="bars">
                  {filteredOpponentGames
                    .slice(0, 10)
                    .reverse()
                    .map((g, i) => {
                      const hit = selected.side === 'Over'
                        ? g.value > selected.line
                        : g.value < selected.line;

                      const push = g.value === selected.line;

                      const maxValue = Math.max(
                        ...filteredOpponentGames
                          .slice(0, 10)
                          .map(r => r.value),
                        1
                      );

                      return (
                        <div className="bar-col" key={i}>
                          <span>{g.value}</span>
                          <div
                            className={
                              'bar ' +
                              (push ? 'push' : hit ? 'hit' : 'miss')
                            }
                            style={{
                              height: `${
                                Math.max(
                                  12,
                                  Math.min(
                                    125,
                                    (g.value / maxValue) * 125
                                  )
                                )
                              }px`
                            }}
                          />
                          <small>{g.date.slice(5)}</small>
                        </div>
                      );
                    })}
                </div>

                <div className="game-list">
                  {filteredOpponentGames.slice(0, 20).map((g, i) => {
                    const hit = selected.side === 'Over'
                      ? g.value > selected.line
                      : g.value < selected.line;

                    const push = g.value === selected.line;

                    return (
                      <div key={i}>
                        <span>
                          {g.date}
                          {gameOpponent(g) ? ` · ${gameOpponent(g)}` : ''}{gameVenue(g) ? ` · ${gameVenue(g) === 'home' ? 'HOME' : 'AWAY'}` : ''}
                        </span>
                        <b>{g.value}</b>
                        <Pill kind={
                          push ? 'neutral' : hit ? 'green' : 'red'
                        }>
                          {push ? 'PUSH' : hit ? 'HIT' : 'MISS'}
                        </Pill>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="empty">
                <h3>{opponentView === 'all' ? 'No matching game logs' : 'No games recorded against this opponent'}</h3>
                <p>
                  Import historical records with the exact player
                  name and market key to calculate hit rates.
                </p>
                <button
                  className="btn secondary"
                  onClick={() => file.current?.click()}
                >
                  <FileUp size={15} /> Import CSV
                </button>
              </div>
            )}

            <div className="drawer-sub muted">
              Sportsbook implied probability at{' '}
              {fmtOdds(selected.odds)}:{' '}
              {(implied(selected.odds) * 100).toFixed(1)}%
              {' '}(vig included). This is NOT a model probability
              or value-bet recommendation.
            </div>
          </aside>
        </div>
      )}

      {modal && (
        <div
          className="overlay center"
          onClick={() => setModal(false)}
        >
          <div
            className="dialog"
            onClick={e => e.stopPropagation()}
          >
            <div className="dialog-top">
              <h2>Add manual player prop</h2>
              <button
                className="iconbtn"
                onClick={() => setModal(false)}
              >
                <X />
              </button>
            </div>

            <p className="muted">
              Use a line from your sportsbook.
              This does not generate historical results.
            </p>

            <ManualForm onSave={addManual} sport={sport} />
          </div>
        </div>
      )}

      {plansOpen && (
        <div className="overlay center" role="presentation" onClick={() => setPlansOpen(false)}>
          <section className="membership-dialog" role="dialog" aria-modal="true" aria-labelledby="membership-title" onClick={e => e.stopPropagation()}>
            <div className="membership-head">
              <div>
                <span className="eyebrow">PROPIQ MEMBERSHIPS</span>
                <h2 id="membership-title">Research plans built for your game</h2>
                <p>Preview membership tiers and test Stripe checkout. Real payments are disabled.</p>
              </div>
              <button className="iconbtn" type="button" aria-label="Close membership plans" onClick={() => setPlansOpen(false)}><X size={21} /></button>
            </div>
            <div className="membership-grid">
              <article className="membership-card">
                <span className="membership-name">Free</span>
                <div className="membership-price">$0 <small>/ month</small></div>
                <p>Explore the PropIQ research experience.</p>
                <ul><li>NBA and NFL prop explorer</li><li>Basic game-history research</li><li>Browser-saved bookmarks</li></ul>
                <span className="membership-status">Currently available · no payment required</span>
              </article>
              <article className="membership-card featured">
                <span className="membership-name">Pro</span>
                <div className="membership-price">$9.99 <small>/ month</small></div>
                <p>Deeper research across games and markets.</p>
                <ul><li>Advanced matchup and trend tools</li><li>Sportsbook odds comparison</li><li>Cloud-saved research after account setup</li></ul>
                <BillingTestActions plan="pro" />
              </article>
              <article className="membership-card">
                <span className="membership-name">Elite</span>
                <div className="membership-price">$19.99 <small>/ month</small></div>
                <p>Expanded tools as our data platform grows.</p>
                <ul><li>Premium research dashboard</li><li>Advanced line movement history</li><li>Future research alerts and analytics</li></ul>
                <BillingTestActions plan="elite" />
              </article>
            </div>
            <p className="membership-note">Stripe test checkout is for development only. No real charges are enabled. Premium research views require a verified, active test subscription.</p>
          </section>
        </div>
      )}

      {help && (
        <div
          className="overlay center"
          onClick={() => setHelp(false)}
        >
          <div
            className="dialog"
            onClick={e => e.stopPropagation()}
          >
            <div className="dialog-top">
              <h2>Getting started</h2>
              <button
                className="iconbtn"
                onClick={() => setHelp(false)}
              >
                <X />
              </button>
            </div>

            <ol className="guide">
              <li>
                Get a key from{' '}
                <a
                  href="https://the-odds-api.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  The Odds API
                </a>
                {' '}and add ODDS_API_KEY to the server environment.
              </li>

              <li>
                Live odds load automatically when you open the
                website or switch sports. You can also refresh manually.
              </li>

              <li>
                Import real game logs using Import Game Logs to
                calculate last-5, last-10 and last-20 hit rates.
              </li>

              <li>
                Player name, market key and sport must match
                the imported data. Use ISO dates (YYYY-MM-DD).
              </li>

              <li>
                Click any prop to view its historical breakdown.
                Bookmark props you want to research later.
              </li>

              <li>
                CSV history and bookmarks are stored in your browser,
                not shared across devices. Reimport your real game
                logs after upgrading from v1.
              </li>
            </ol>

            <a
              className="btn secondary download"
              href="/sample-game-logs.csv"
              download
            >
              <Download size={17} /> Download example CSV
            </a>

            {importError && (
              <p className="error">{importError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Rate({ rate }: { rate?: number | null }) {
  return (
    <div className={
      'rate ' +
      (rate == null
        ? 'dim'
        : rate >= 70
          ? 'good'
          : rate >= 50
            ? 'mid'
            : 'low')
    }>
      {pct(rate)}
    </div>
  );
}

function ManualForm({
  onSave,
  sport
}: {
  onSave: (form: FormData) => void;
  sport: Sport;
}) {
  const [sp, setSp] = useState<Sport>(sport);

  return (
    <form className="manual-form" action={onSave}>
      <label>
        Sport
        <select
          name="sport"
          value={sp}
          onChange={e => setSp(e.target.value as Sport)}
        >
          <option>NBA</option>
          <option>NFL</option>
        </select>
      </label>

      <label>
        Player
        <input
          required
          name="player"
          placeholder="Exact player name"
        />
      </label>

      <label>
        Market
        <select name="marketKey">
          {Object.entries(MARKETS[sp]).map(([key, value]) => (
            <option key={key} value={key}>{value}</option>
          ))}
        </select>
      </label>

      <div className="form-row">
        <label>
          Direction
          <select name="side">
            <option>Over</option>
            <option>Under</option>
          </select>
        </label>

        <label>
          Line
          <input
            required
            type="number"
            step="0.5"
            name="line"
            placeholder="24.5"
          />
        </label>

        <label>
          American odds
          <input
            required
            type="number"
            name="odds"
            defaultValue={-110}
          />
        </label>
      </div>

      <label>
        Bookmaker
        <input
          name="bookmaker"
          placeholder="Sportsbook name"
        />
      </label>

      <label>
        Matchup
        <input
          name="event"
          placeholder="Away @ Home"
        />
      </label>

      <button type="submit" className="btn primary full">
        <Plus size={16} /> Add Prop
      </button>
    </form>
  );
}
