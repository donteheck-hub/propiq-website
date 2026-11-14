
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownUp, BarChart3, Bookmark, CalendarDays,
  ChevronDown, CircleHelp, Download, FileUp, Filter,
  LayoutDashboard, Plus, RefreshCw, Search, ShieldCheck,
  SlidersHorizontal, Target, TrendingUp, X
} from 'lucide-react';
import {
  analyze, currentSeason, defenseContext, type DefenseRow, gameOpponent, gameVenue, implied, logSeason, type LogRow, MARKETS, normalize, recentTrends, parseCsv, parseDefenseCsv, type Prop, seasonLabel, splitHistory, type Sport
} from '../lib/props';

const STORAGE_KEY = 'prop-iq-v2';
const PAGE_SIZE = 40;
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;
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

type LiveStatus = 'loading' | 'live' | 'unavailable';
type SportsbookFilter = 'both' | 'draftkings' | 'fanduel';
type SortField = 'last5' | 'last10' | 'average';

const normalizeBook = (name: string) =>
  name.toLowerCase().replace(/[^a-z]/g, '');

export default function Home() {
  const [sport, setSport] = useState<Sport>('NBA');
  const [seasonView, setSeasonView] = useState<'current' | 'previous' | 'all'>('current');
  const [sortField, setSortField] = useState<SortField>('last10');
  const [sortDescending, setSortDescending] = useState(true);
  const [tab, setTab] = useState<'explore' | 'saved'>('explore');
  const [props, setProps] = useState<Prop[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [autoLogs, setAutoLogs] = useState<LogRow[]>([]);
  const [historyStatus, setHistoryStatus] = useState('Loading historical game data...');
  const [status, setStatus] = useState<LiveStatus>('loading');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [market, setMarket] = useState('all');
  const [sportsbook, setSportsbook] = useState<SportsbookFilter>('both');
  const [side, setSide] = useState('all');
  const [minHit, setMinHit] = useState(0);
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
        if (Array.isArray(data.saved)) setSaved(data.saved);
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
          saved,
          defenseRows
        })
      );
    } catch (error) {
      console.error('Unable to save research:', error);
    }
  }, [hydrated, props, logs, saved, defenseRows]);

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

      const liveProps = data.props as Prop[];

      setProps(previous => [
        ...previous.filter(
          p =>
            p.source === 'manual' ||
            (p.source === 'live' && p.sport !== selectedSport)
        ),
        ...liveProps
      ]);

      setStatus('live');
      setOddsCoverage(typeof data.availableEvents === 'number' ? `Odds coverage: ${data.eventsChecked} of ${data.availableEvents} upcoming games checked. ${Array.isArray(data.warnings) && data.warnings.length ? `${data.warnings.length} provider error(s).` : ''}` : '');
      setLastUpdated(new Date().toLocaleTimeString());

      setNotice(
        data.message ||
        `${liveProps.length} live ${selectedSport} props loaded. ${
          data.notice || ''
        }`
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

  useEffect(() => {
    if (!hydrated || historyPlayers.length === 0) return;
    const controller = new AbortController();
    setHistoryStatus(`Loading ${sport} history for ${historyPlayers.length} players...`);
    const timer = setTimeout(() => controller.abort(), 45000);
    async function load() {
      try {
        const response = await fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sport, players: historyPlayers.slice(0, 120) }),
          cache: 'no-store', signal: controller.signal
        });
        if (!response.ok) throw new Error(`History API returned ${response.status}`);
        const size = Number(response.headers.get('content-length') || 0);
        if (size > MAX_HISTORY_BYTES) throw new Error('Filtered history still exceeds the response limit.');
        const text = await response.text();
        if (text.length > MAX_HISTORY_BYTES) throw new Error('Filtered history still exceeds the response limit.');
        const data = JSON.parse(text);
        if (!Array.isArray(data.rows)) throw new Error('Invalid history response');
        if (controller.signal.aborted) return;
        setAutoLogs(previous => [...previous.filter(r => r.sport !== sport), ...(data.rows as LogRow[])]);
        setHistoryStatus(data.message || `Loaded ${data.rows.length} historical observations.`);
      } catch (error) {
        if (!controller.signal.aborted) setHistoryStatus(
          error instanceof Error ? `History unavailable: ${error.message}` : 'Automatic history unavailable. CSV import remains available.'
        );
      } finally { clearTimeout(timer); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  // Players are sorted, so this key changes only when the available set changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sport, historyPlayerKey]);

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

  const visible = useMemo(() => sportProps
    .filter(p =>
      (tab === 'explore' || saved.includes(p.id)) &&
      (market === 'all' || p.marketKey === market) &&
      (side === 'all' || p.side === side) &&
      (sportsbook === 'both'
        ? ['draftkings', 'fanduel'].includes(normalizeBook(p.bookmaker))
        : normalizeBook(p.bookmaker) === sportsbook) &&
      `${p.player} ${p.event} ${p.bookmaker}`.toLowerCase().includes(query.toLowerCase()) &&
      (minHit === 0 || (p.stats.hit10?.total ?? 0) >= MIN_SAMPLE_FOR_HIGHLIGHT && (p.stats.hit10?.pct ?? -1) >= minHit)
    )
    .sort((a, b) => {
      const metric = (p: typeof a) => sortField === 'last5'
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
    [sportProps, tab, saved, market, side, sportsbook, query, minHit, sortField, sortDescending]
  );

  useEffect(() => { setPage(1); }, [sport, tab, query, market, side, sportsbook, minHit, seasonView]);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const displayed = useMemo(() => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [visible, safePage]);
  const selectedStats = useMemo(() => selected ? analyze(selected,
    logIndex.get(`${selected.sport}|${normalize(selected.player)}|${selected.marketKey}`) || [], seasonFor(selected.sport)
  ) : null, [selected, logIndex, seasonFor]);

  const selectedTrends = useMemo(() => selected && selectedStats
    ? recentTrends(selectedStats.games, selected) : null, [selected, selectedStats]);
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


  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-icon">
            <Activity size={24} />
          </div>
          <div>
            PROP<span>IQ</span>
            <small>THE RESEARCH EDGE</small>
          </div>
        </div>

        <div className="side-label">WORKSPACE</div>

        <button
          className={'nav ' + (tab === 'explore' ? 'active' : '')}
          onClick={() => setTab('explore')}
        >
          <LayoutDashboard size={18} />
          Prop Explorer
        </button>

        <button
          className={'nav ' + (tab === 'saved' ? 'active' : '')}
          onClick={() => setTab('saved')}
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
          <div className="crumb">
            Workspace <span>/</span>{' '}
            {tab === 'explore' ? 'Prop Explorer' : 'Saved Props'}
          </div>

          <div className="top-actions">
            <Pill kind={status === 'live' ? 'green' : 'amber'}>
              {loading
                ? 'LOADING ODDS'
                : status === 'live'
                  ? 'LIVE ODDS'
                  : 'ODDS UNAVAILABLE'}
            </Pill>
            <button className="avatar" title="Local profile">PI</button>
          </div>
        </header>

        <div className="content">
          <div className="heading">
            <div>
              <div className="eyebrow">
                <span className="dot" /> YOUR ANALYTICS HUB
              </div>

              <h1>
                {tab === 'explore' ? 'Prop Explorer' : 'Your Watchlist'}
              </h1>

              <p>
                Research live player props, historical results,
                and transparent data coverage.
              </p>
            </div>

            <div className="heading-actions">
              <button className="btn secondary" type="button" onClick={() => defenseFile.current?.click()} title="Import sourced team defensive averages (CSV)">
                <FileUp size={16} /> Defense CSV
              </button>
              <button
                className="btn primary"
                disabled={loading}
                onClick={() => refresh(sport)}
              >
                <RefreshCw
                  className={loading ? 'spin' : ''}
                  size={16}
                />
                {loading ? 'Checking...' : 'Refresh Live Odds'}
              </button>
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

          <section className="stats-grid">
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
              Last successful odds check: {lastUpdated}
            </p>
          )}

          <div className="coverage-note" role="status">
            <ShieldCheck size={16} />
            <span>{oddsCoverage || 'Live odds coverage details appear after refresh.'} {historyStatus} Hit rates use available games; incomplete samples are labeled.</span>
          </div>

          <div className="section-title">
            <div>
              <h2>Explore player props</h2>
              <p>
                Click Last 5, Last 10, or L10 AVG to sort player props.
                Click a prop for a game-by-game breakdown.
              </p>
            </div>

            <span className="results">
              {visible.length} results
            </span>
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
          <div className="table-card">
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
                        <div className="player-name">{p.player}</div>
                        <div className="muted smaller">{p.event}</div>
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
                            (saved.includes(p.id) ? 'saved' : '')
                          }
                          onClick={e => {
                            e.stopPropagation();
                            setSaved(previous =>
                              previous.includes(p.id)
                                ? previous.filter(id => id !== p.id)
                                : [...previous, p.id]
                            );
                          }}
                        >
                          <Bookmark
                            size={17}
                            fill={
                              saved.includes(p.id)
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
                  {loading ? 'Loading player props...' : 'No props found'}
                </h3>
                <p>
                  {loading
                    ? 'Checking available sportsbook lines.'
                    : 'Try another filter, add a manual prop, or refresh the live odds.'}
                </p>
              </div>
            )}
          </div>

          {comparison.length > 0 && (
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

          {visible.length > PAGE_SIZE && (
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

          {defenseError && <p className="defense-error" role="alert">Defense CSV: {defenseError}</p>}
          <p className="defense-hint">Optional defense CSV columns: <code>sport,season,team,marketKey,allowedPerGame,games,source</code>. Import a verified team-level stat source for matchup context. Data is stored on this browser only.</p>
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
              <div>
                <span className="eyebrow">
                  PLAYER PROP BREAKDOWN
                </span>
                <h2>{selected.player}</h2>
                <p>{selected.event}</p>
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
                <small>Import a properly sourced team-level defensive CSV. Choose the opponent manually; league ranks require all {selected.sport === 'NBA' ? 30 : 32} teams for this market and season.</small>
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
              </div> : <p className="split-note">{defenseTeams.length ? 'Select a team to review imported defensive statistics.' : 'No imported defensive data for this market and season. Use the Defense CSV button above to add records.'}</p>}
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
                Line: {selected.line} · green = hit · orange = miss
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
                          push ? 'neutral' : hit ? 'green' : 'amber'
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
