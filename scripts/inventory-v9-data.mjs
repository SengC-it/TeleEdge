import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {APP_DIR} from '../src/config.mjs';
import {loadV9Universe} from '../src/v9/universe.mjs';

const START = '2024-01-01T00:00:00.000Z';
const END = '2026-01-01T00:00:00.000Z';

function cliValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function artifactAvailability(manifest, kind, interval, selected) {
  const artifacts = (manifest.artifacts || []).filter(row => row.kind === kind);
  const windowStart = Date.parse(START);
  const windowEnd = Date.parse(END);
  const usable = artifacts.filter(row => {
    const first = Date.parse(row.firstTimestamp || row.activeStart || '');
    const last = Date.parse(row.lastTimestamp || row.activeEnd || '');
    return Number(row.rows) > 0 && row.sha256 && Number.isFinite(first) && Number.isFinite(last) && first < windowEnd && last >= windowStart;
  });
  const timestamps = usable.flatMap(row => [
    new Date(Math.max(windowStart, Date.parse(row.firstTimestamp || row.activeStart))).toISOString(),
    new Date(Math.min(windowEnd, Date.parse(row.lastTimestamp || row.activeEnd))).toISOString(),
  ]).sort();
  const symbolsCovered = new Set(usable.map(row => row.symbol).filter(Boolean)).size;
  return {
    localFiles: artifacts.length,
    localRows: artifacts.reduce((sum, row) => sum + (Number(row.rows) || 0), 0),
    historicalStart: timestamps[0] || null,
    historicalEnd: timestamps.at(-1) || null,
    symbolsCovered,
    symbolsRequired: selected,
    interval,
    complete: selected > 0 && symbolsCovered === selected,
  };
}

function markdown(report) {
  const rows = report.sources.map(source => `| ${source.id} | ${source.name} | ${source.available ? 'yes' : 'no'} | ${source.interval} | ${source.historicalStart || '—'} | ${source.historicalEnd || '—'} | ${source.symbolsCovered}/${source.symbolsRequired} | ${source.publicNoAuth ? 'yes' : 'no'} | ${source.access} | ${source.complete ? 'yes' : 'no'} | ${source.used ? 'yes' : 'no'} | ${source.reason} |`).join('\n');
  return `# V9 Derivatives Data Availability\n\nInventory only; no strategy optimization or Holdout was run.\n\n- Development window: ${report.window.start} through ${report.window.end}\n- Requested universe: ${report.universe.requested}; deterministic selection: ${report.universe.selected}; hash: ${report.universe.hash}\n- M4 status: **${report.m4Status}**\n\n| ID | Source | Available | Interval | Historical start | Historical end | Symbols | Public/no-auth | Archive/API | Complete | Used | Status/reason |\n|---|---|---|---|---|---|---:|---|---|---|---|---|\n${rows}\n\n## Explicit non-proxy boundary\n\nHistorical open interest and long/short ratio endpoints were observed to be recent-only for this window. They are marked unavailable; no current-value proxy is substituted. Data availability alone does not make the inherited M4 dataset point-in-time complete.\n`;
}

export function buildV9AvailabilityReport({appDir = APP_DIR, dataRoot = path.join(APP_DIR, 'data', 'backtest'), developmentRoot = path.join(APP_DIR, 'data', 'v9-development')} = {}) {
  const baseFile = path.join(dataRoot, 'manifest.json');
  const base = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, 'utf8')) : {};
  const v9File = path.join(developmentRoot, 'manifest.json');
  const v9 = fs.existsSync(v9File) ? JSON.parse(fs.readFileSync(v9File, 'utf8')) : {};
  let selectedUniverse = null;
  try {
    selectedUniverse = loadV9Universe(dataRoot, appDir, {start: Date.parse(START), end: Date.parse(END), limit: 150});
  } catch {
    selectedUniverse = null;
  }
  const symbols = v9.universe?.symbols || selectedUniverse?.symbols || base.universe?.symbols || [];
  const selected = symbols.length;
  const artifact = (kind, interval) => artifactAvailability(v9, kind, interval, selected);
  const unavailable = interval => ({localFiles: 0, localRows: 0, historicalStart: null, historicalEnd: null, symbolsCovered: 0, symbolsRequired: selected, interval, complete: false});
  const sourceRows = [
    {id: 'A', name: 'USD-M futures kline taker-buy volume', ...artifact('taker-1h', '1h'), available: artifact('taker-1h', '1h').localFiles > 0, publicNoAuth: true, access: 'Binance Data Vision monthly/daily archive', used: true, reason: 'FLOW and cross-sectional feature input'},
    {id: 'B', name: 'USD-M aggTrades / public trades', ...unavailable('event'), available: true, publicNoAuth: true, access: 'Binance Data Vision archive', used: false, reason: 'public source exists; not downloaded because no preregistered V9 feature requires it'},
    {id: 'C', name: 'USD-M premium index klines', ...artifact('premium-1h', '1h'), available: artifact('premium-1h', '1h').localFiles > 0, publicNoAuth: true, access: 'Binance Data Vision monthly/daily archive', used: true, reason: 'PREMIUM_DISLOCATION input'},
    {id: 'D', name: 'USD-M mark price klines', ...artifact('mark-1h', '1h'), available: artifact('mark-1h', '1h').localFiles > 0, publicNoAuth: true, access: 'Binance Data Vision monthly/daily archive', used: true, reason: 'mark/index spread input'},
    {id: 'E', name: 'USD-M index price klines', ...artifact('index-1h', '1h'), available: artifact('index-1h', '1h').localFiles > 0, publicNoAuth: true, access: 'Binance Data Vision monthly/daily archive', used: true, reason: 'mark/index spread input'},
    {id: 'F', name: 'USD-M funding history', ...artifact('funding', 'event'), available: artifact('funding', 'event').localFiles > 0, publicNoAuth: true, access: 'Binance Data Vision archive / normalized local artifact', used: true, reason: 'funding feature and execution cost model'},
    {id: 'G', name: 'Historical open interest', ...unavailable('5m/recent-only'), available: false, publicNoAuth: true, access: 'Binance public market-data API', used: false, reason: 'no reliable 2024-2025 public history; OI family fail-closed'},
    {id: 'H', name: 'Global long/short ratio', ...unavailable('5m/recent-only'), available: false, publicNoAuth: true, access: 'Binance public market-data API', used: false, reason: 'no reliable 2024-2025 public history; no proxy'},
    {id: 'I', name: 'Top trader long/short ratio', ...unavailable('5m/recent-only'), available: false, publicNoAuth: true, access: 'Binance public market-data API', used: false, reason: 'no reliable 2024-2025 public history; no proxy'},
    {id: 'J', name: 'Taker long/short ratio', ...unavailable('5m/recent-only'), available: false, publicNoAuth: true, access: 'Binance public market-data API', used: false, reason: 'no reliable 2024-2025 public history; no proxy'},
  ];
  const report = {
    reportVersion: 'v9-data-availability-1', generatedAt: new Date().toISOString(), window: {start: START, end: END},
    m4Status: v9.status || base.status || 'M4-INCOMPLETE',
    universe: {requested: selectedUniverse?.requestedSymbols || base.universe?.symbols?.length || 0, selected, hash: v9.universe?.symbolsHash || selectedUniverse?.symbolsHash || null, symbols},
    sources: sourceRows,
    decision: 'Development may use only sources with observed local files; missing derivative histories remain unavailable and never use a proxy.',
  };
  fs.mkdirSync(path.join(appDir, 'reports'), {recursive: true});
  fs.writeFileSync(path.join(appDir, 'reports', 'v9-data-availability.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(appDir, 'reports', 'v9-data-availability.md'), markdown(report), 'utf8');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dataRoot = path.resolve(cliValue('--data-root', path.join(APP_DIR, 'data', 'backtest')));
  const developmentRoot = path.resolve(cliValue('--development-root', path.join(APP_DIR, 'data', 'v9-development')));
  console.log(JSON.stringify(buildV9AvailabilityReport({dataRoot, developmentRoot}), null, 2));
}
