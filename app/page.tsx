
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownUp, BarChart3, Bookmark, CalendarDays,
  ChevronDown, CircleHelp, Download, FileUp, Filter,
  LayoutDashboard, Menu, Plus, RefreshCw, Search, ShieldCheck, Sparkles, ArrowLeftRight,
  SlidersHorizontal, Target, TrendingUp, X, Shield, History, Gauge, ArrowUpRight, Database
} from 'lucide-react';
import {
  analyze, currentSeason, defenseContext, type DefenseRow, gameOpponent, gameVenue, implied, logSeason, type LogRow, MARKETS, normalize, recentTrends, parseCsv, parseDefenseCsv, type Prop, seasonLabel, splitHistory, type Sport
} from '../lib/props';

const STORAGE_KEY = 'prop-iq-v2';
const ODDS_HISTORY_KEY = 'prop-iq-odds-history-v1';
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
  const [tab, setTab] = useState<'dashboard' | 'explore' | 'saved' | 'finder' | 'odds' | 'matchups' | 'movement'>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [props, setProps] = useState<Prop[]>([]);
  const [oddsSamples, setOddsSamples] = useState<OddsSample[]>([]);
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
  const [matchupOpponent, setMatchupOpponent] = useState('all');
  const [selected, setSelected] = useState<Prop | null>(null);
  const [opponentView, setOpponentView] = useState('all');
  const [defenseTeam, setDefenseTeam] = useState('');
  const [defenseRows, setDefenseRows] = useState<DefenseRow[]>([]);
  const [defenseError, setDefenseError] = useState('');
  const [saved, setSaved] = useState<string[]>([]);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [modal, setModal] = useState(false);
  const [help, setHelp] = useState(false);
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
        if (Array.isArray(data.saved)) setSaved(data.saved.filter((value: unknown): value is string => typeof value === 'string' && value.length < 512));
        if (Array.isArray(data.defenseRows)) setDefenseRows(data.defenseRows.filter((r: DefenseRow) => r && (r.sport === 'NBA' || r.sport === 'NFL') && Number.isFinite(r.allowedPerGame) && Number.isInteger(r.season) && typeof r.team === 'string' && typeof r.source === 'string'));
      }
    } catch (error) {
      console.error('Unable to restore saved research:', error);
    }

    try {
      const savedHistory = JSON.parse(localStorage.getItem(ODDS_HISTORY_KEY) || '[]');
      if (Array.isArray(savedHistory)) setOddsSamples(savedHistory.filter((row: OddsSample) =>
        row && (row.sport === 'NBA' || row.sport === 'NFL') &&
        Number.isFinite(row.line) && Number.isFinite(row.odds) &&
        typeof row.observedAt === 'string' && !Number.isNaN(Date.parse(row.observedAt))
      ).slice(-12000));
    } catch (error) { console.warn('Could not restore odds history', error); }
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
          saved,
          defenseRows
        })
      );
    } catch (error) {
      console.error('Unable to save research:', error);
    }
  }, [hydrated, props, logs, saved, defenseRows]);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(ODDS_HISTORY_KEY, JSON.stringify(oddsSamples)); }
    catch (error) { console.warn('Could not save odds history', error); }
  }, [hydrated, oddsSamples]);

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

      // Capture real provider snapshots only. Reopening cached data with the
      // same provider timestamp does not create fictitious movement.
      if (!data.stale && data.updatedAt && !Number.isNaN(Date.parse(data.updatedAt))) {
        const observedAt: string = new Date(data.updatedAt).toISOString();
        const newSamples: OddsSample[] = liveProps.filter(p => p.source === 'live' &&
          Number.isFinite(p.line) && Number.isFinite(p.odds)).slice(0, 1200).map(p => ({
          sport: p.sport, player: p.player, event: p.event, commence: p.commence,
          market: p.market, marketKey: p.marketKey, side: p.side,
          bookmaker: p.bookmaker, line: p.line, odds: p.odds, observedAt
        }));
        setOddsSamples(previous => {
          const oldest = Date.now() - 30 * 86400000;
          const unique = new Map<string, OddsSample>();
          for (const row of [...previous, ...newSamples]) {
            if (Date.parse(row.observedAt) >= oldest) unique.set(`${sampleKey(row)}|${row.observedAt}`, row);
          }
          return [...unique.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).slice(-12000);
        });
      }

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
  const oddsComparisons = useMemo(() => {
    const groups = new Map<string, Map<string, Prop>>();
    for (const prop of sportProps) {
      const book = normalizeBook(prop.bookmaker);
      if (prop.source !== 'live' || !['draftkings', 'fanduel'].includes(book) ||
          !Number.isFinite(prop.odds) || prop.odds === 0) continue;
      if ((market !== 'all' && prop.marketKey !== market) ||
          (side !== 'all' && prop.side !== side) ||
          !`${prop.player} ${prop.event} ${prop.bookmaker}`.toLowerCase().includes(query.toLowerCase())) continue;
      const key = [prop.sport, normalize(prop.player), normalize(prop.event), prop.commence,
        prop.marketKey, prop.side, prop.line].join('|');
      if (!groups.has(key)) groups.set(key, new Map());
      const books = groups.get(key)!;
      const old = books.get(book);
      if (!old || prop.odds > old.odds) books.set(book, prop);
    }
    return [...groups.values()].filter(books => books.size >= 2).map(books => {
      const offers = [...books.values()].sort((a, b) => b.odds - a.odds);
      return { best: offers[0], other: offers[1], gain: profitOn100(offers[0].odds) - profitOn100(offers[1].odds) };
    }).sort((a, b) => b.gain - a.gain || a.best.player.localeCompare(b.best.player));
  }, [sportProps, market, side, query]);

  const visible = useMemo(() => sportProps
    .filter(p =>
      (tab !== 'saved' || isSaved(p, saved)) &&
      (tab !== 'finder' || (p.source === 'live' && p.stats.games.length >= finderSample && (finderSample === 20 ? p.stats.hit20?.pct : p.stats.hit10?.pct) !== null && (finderSample === 20 ? (p.stats.hit20?.pct ?? -1) : (p.stats.hit10?.pct ?? -1)) >= finderThreshold)) &&
      (market === 'all' || p.marketKey === market) &&
      (side === 'all' || p.side === side) &&
      (sportsbook === 'both'
        ? ['draftkings', 'fanduel'].includes(normalizeBook(p.bookmaker))
        : normalizeBook(p.bookmaker) === sportsbook) &&
      `${p.player} ${p.event} ${p.bookmaker}`.toLowerCase().includes(query.toLowerCase()) &&
      (minHit === 0 || (p.stats.hit10?.total ?? 0) >= MIN_SAMPLE_FOR_HIGHLIGHT && (p.stats.hit10?.pct ?? -1) >= minHit)
    )
    .sort((a, b) => {
      const metric = (p: typeof a) => tab === 'finder'
        ? (finderSample === 20 ? p.stats.hit20?.pct : p.stats.hit10?.pct)
        : sortField === 'last5'
        ? p.stats.hit5?.pct
        : sortField === 'average'
          ? p.stats.avg
          : p.stats.hit10?.pct;
      const av = metric(a), bv = metric(b);
      if (av == null && bv == null) return a.player.localeCompare(b.player);
      if (av == null) return 1;
      if (bv == null) return -1;
      return (sortDescending ? bv - av : av - bv) || a.player.localeCompare(b.player);
    }),
    [sportProps, tab, saved, market, side, sportsbook, query, minHit, sortField, sortDescending, finderThreshold, finderSample]
  );

  useEffect(() => { setPage(1); }, [sport, tab, query, market, side, sportsbook, minHit, seasonView, finderThreshold, finderSample]);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const displayed = useMemo(() => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [visible, safePage]);
  const selectedStats = useMemo(() => selected ? analyze(selected,
    logIndex.get(`${selected.sport}|${normalize(selected.player)}|${selected.marketKey}`) || [], seasonFor(selected.sport)
  ) : null, [selected, logIndex, seasonFor]);

  const selectedTrends = useMemo(() => selected && selectedStats
    ? recentTrends(selectedStats.games, selected) : null, [selected, selectedStats]);
  // Opponents are taken only from actual historical game logs. We deliberately
  // do not infer today's opposing team from a matchup string with no roster ID.
  const matchupCandidates = useMemo(() => {
    const seen = new Set<string>();
    return visible.filter(p => {
      if (!p.stats.games.length) return false;
      const key = [p.sport, normalize(p.player), p.marketKey, p.side, p.line].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [visible]);
  const matchupOpponents = useMemo(() => [...new Set(matchupCandidates.flatMap(p =>
    p.stats.games.map(g => gameOpponent(g)).filter((s): s is string => !!s && s !== 'Unknown')
  ))].sort(), [matchupCandidates]);
  const matchupCards = useMemo(() => matchupCandidates.map(p => {
    const games = matchupOpponent === 'all' ? p.stats.games : p.stats.games.filter(g => gameOpponent(g) === matchupOpponent);
    const hits = games.filter(g => p.side === 'Over' ? g.value > p.line : g.value < p.line).length;
    const pushes = games.filter(g => g.value === p.line).length;
    const average = games.length ? games.reduce((sum, g) => sum + g.value, 0) / games.length : null;
    return { prop: p, games: games.length, hits, pushes, average };
  }).filter(x => x.games > 0).sort((a, b) => b.games - a.games || a.prop.player.localeCompare(b.prop.player)), [matchupCandidates, matchupOpponent]);

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

  // Dashboard summaries come from recorded data only, with a full 10-game sample.
  // Collapse identical sportsbook offers to avoid treating the same prop as many trends.
  const dashboardTrends = useMemo(() => {
    const byProp = new Map<string, (typeof sportProps)[number]>();
    for (const p of sportProps) {
      if (p.source !== 'live' || p.stats.hit10?.total !== 10) continue;
      const key = [normalize(p.player), p.marketKey, p.side, p.line, normalize(p.event), p.commence].join('|');
      const previous = byProp.get(key);
      if (!previous || p.odds > previous.odds) byProp.set(key, p);
    }
    return [...byProp.values()].sort((a,b) =>
      (b.stats.hit10?.pct ?? 0) - (a.stats.hit10?.pct ?? 0) ||
      a.player.localeCompare(b.player)).slice(0,5);
  }, [sportProps]);
  const dashboardCoverage = useMemo(() => {
    const live = sportProps.filter(p => p.source === 'live');
    const withHistory = live.filter(p => p.stats.games.length > 0).length;
    const fullTen = live.filter(p => p.stats.hit10?.total === 10).length;
    const uniquePlayers = new Set(live.map(p => normalize(p.player))).size;
    return { live:live.length, withHistory, fullTen, uniquePlayers };
  }, [sportProps]);
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
          <Gauge size={18} /> Research Dashboard
        </button>

        <button
          className={'nav ' + (tab === 'explore' ? 'active' : '')}
          onClick={() => { setTab('explore'); setMobileNavOpen(false); }}
        >
          <LayoutDashboard size={18} />
          Prop Explorer
        </button>

        <button className={'nav ' + (tab === 'finder' ? 'active' : '')} onClick={() => { setTab('finder'); setSortDescending(true); setMobileNavOpen(false); }}>
          <Sparkles size={18} /> Smart Finder
        </button>

        <button className={'nav ' + (tab === 'matchups' ? 'active' : '')} onClick={() => { setTab('matchups'); setMobileNavOpen(false); }}>
          <Shield size={18} /> Matchup Center
        </button>

        <button className={'nav ' + (tab === 'movement' ? 'active' : '')} onClick={() => { setTab('movement'); setMobileNavOpen(false); }}>
          <History size={18} /> Line History
        </button>

        <button className={'nav ' + (tab === 'odds' ? 'active' : '')} onClick={() => { setTab('odds'); setMobileNavOpen(false); }}>
          <ArrowLeftRight size={18} /> Odds Comparison
        </button>

        <button
          className={'nav ' + (tab === 'saved' ? 'active' : '')}
          onClick={() => { setTab('saved'); setMobileNavOpen(false); }}
        >
          <Bookmark size={18} />
          Saved Props <b>{saved.length || ''}</b>
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
              <div className="command-metrics">
                <div><span><Database size={15}/> Live offers</span><strong>{dashboardCoverage.live}</strong><small>Player prop outcomes</small></div>
                <div><span><Activity size={15}/> Players listed</span><strong>{dashboardCoverage.uniquePlayers}</strong><small>Distinct players</small></div>
                <div><span><BarChart3 size={15}/> With history</span><strong>{dashboardCoverage.withHistory}</strong><small>Of {dashboardCoverage.live} live offers</small></div>
                <div><span><ShieldCheck size={15}/> Full L10 samples</span><strong>{dashboardCoverage.fullTen}</strong><small>10 recorded games required</small></div>
              </div>
              <div className="command-grid">
                <div className="command-panel">
                  <div className="command-panel-head"><div><h3>Historical trend watch</h3><p>Highest observed Last 10 hit rates · complete samples</p></div><button onClick={() => setTab('finder')}>Smart Finder <ArrowUpRight size={15}/></button></div>
                  {dashboardTrends.length ? dashboardTrends.map(p => (
                    <button className="command-trend-row" key={p.id} onClick={() => setSelected(p)}>
                      <PlayerAvatar name={p.player} {...playerHeadshots.get(`${p.sport}|${normalize(p.player)}`)}/>
                      <span className="command-item-label"><strong>{p.player}</strong><small>{p.side} {p.line} {p.market} · {p.bookmaker}</small></span>
                      <span className="command-rate">{p.stats.hit10?.pct}%<small>{p.stats.hit10?.hits}/10</small></span>
                    </button>
                  )) : <p className="command-empty">No complete 10-game samples yet. Check your season selection or historical-data coverage.</p>}
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
                <div className="finder-count"><strong>{visible.length}</strong><span>matching live props</span></div>
              </div>
              <p className="finder-disclaimer"><ShieldCheck size={14}/> A historical hit rate does not estimate the chance of a future result. No projections or expected-value claims are made.</p>
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
                <p>Saved only when this browser receives a new provider data timestamp. Showing up to 30 days of available observations (maximum 12,000 stored records). No earlier changes can be reconstructed.</p></div>
              </div>
              {movementRows.length ? (
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
              ) : <div className="empty"><History size={28}/><h3>No line history recorded yet</h3><p>The first successful odds load creates a baseline. A later, newly timestamped snapshot is needed to show actual movement.</p></div>}
              <p className="finder-disclaimer"><ShieldCheck size={14}/> Browser-only history: not shared across devices or users, and clearing browser data deletes it. This is not a real-time line movement feed.</p>
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
              {matchupCards.length ? (
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
              ) : <div className="empty"><h3>No recorded matchups found</h3><p>Try another opponent or season. If game logs are missing, the historical feed must be restored first.</p></div>}
              {matchupCards.length > 80 && <p className="muted smaller">Showing 80 matching props. Use search or market filters to narrow results.</p>}
              <p className="finder-disclaimer"><ShieldCheck size={14}/> Results describe historical games, not a forecast. Current opponent is not inferred from event titles. Team defense rankings require the optional sourced CSV import.</p>
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
              ) : <div className="empty"><h3>No matching prices at identical lines</h3><p>Both sportsbooks must offer the same player, game, market, direction, and line. Try resetting market and direction filters or refreshing live odds.</p></div>}
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
                  {loading ? 'Loading player props...' : tab === 'finder' ? 'No qualifying trends' : sportProps.length === 0 ? `No ${sport} sportsbook props available` : 'No props match these filters'}
                </h3>
                <p>
                  {loading
                    ? 'Checking available sportsbook lines.'
                    : tab === 'finder' ? 'Try a lower hit-rate threshold, a different season, or Last 10. Missing history is not a missed bet.' : sportProps.length === 0 ? (notice || 'Sportsbooks may not have posted these player markets yet. Try refreshing nearer to kickoff; provider errors appear above.') : 'Try another filter, reset filters, or refresh live odds.'}
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
