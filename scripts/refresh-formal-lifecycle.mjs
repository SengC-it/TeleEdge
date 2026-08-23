import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {CORE_MARKETS} from '../src/config.mjs';
import {lifecycleFromEvidence} from './build-formal-dataset.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = path.join(APP_DIR, 'data', 'backtest');

function timeValue(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

function monthStart(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, 1) : NaN;
}

function monthEnd(value) {
  const start = monthStart(value);
  return Number.isFinite(start) ? Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1) : NaN;
}

function loadEvidence(file) {
  if (!file || !fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = Array.isArray(parsed) ? parsed : parsed.markets;
  return Object.fromEntries((records || []).filter(record => record?.symbol).map(record => [record.symbol, record]));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function observedBoundsForGzip(file, cutoff = null) {
  if (!fs.existsSync(file)) return {};
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  const pattern = /\{"t":(-?\d+),[^{}]*?"q":(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[^{}]*\}/g;
  let carry = '';
  let firstObservedTimestamp = null;
  let lastObservedTimestamp = null;
  let rawFirstObservedTimestamp = null;
  let rawLastObservedTimestamp = null;
  let postLifecycleRowsExcluded = 0;
  const consume = text => {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text))) {
      if (Number(match[2]) > 0) {
        const timestamp = Number(match[1]);
        rawFirstObservedTimestamp ??= timestamp;
        rawLastObservedTimestamp = timestamp;
        if (Number.isFinite(cutoff) && timestamp >= cutoff) {
          postLifecycleRowsExcluded++;
        } else {
          firstObservedTimestamp ??= timestamp;
          lastObservedTimestamp = timestamp;
        }
      }
    }
  };
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => {
      carry += chunk.toString('utf8');
      const end = carry.lastIndexOf('}');
      if (end < 0) return;
      consume(carry.slice(0, end + 1));
      carry = carry.slice(end + 1);
    });
    stream.on('end', () => {
      consume(carry);
      resolve({firstObservedTimestamp, lastObservedTimestamp, rawFirstObservedTimestamp, rawLastObservedTimestamp, postLifecycleRowsExcluded});
    });
    stream.on('error', reject);
  });
}

async function observedSummaryFor(artifact, {scan = true, cutoff = null} = {}) {
  if (!artifact) return {};
  if (artifact.firstObservedTimestamp && artifact.lastObservedTimestamp && !Number.isFinite(cutoff)) return artifact;
  if (!scan && artifact.firstTimestamp && artifact.lastTimestamp) {
    artifact.firstObservedTimestamp = artifact.firstTimestamp;
    artifact.lastObservedTimestamp = artifact.lastTimestamp;
    return artifact;
  }
  const file = path.join(APP_DIR, artifact.path);
  if (!fs.existsSync(file)) return artifact;
  const bounds = await observedBoundsForGzip(file, cutoff);
  const firstObservedTimestamp = bounds.firstObservedTimestamp;
  const lastObservedTimestamp = bounds.lastObservedTimestamp;
  artifact.firstObservedTimestamp = Number.isFinite(firstObservedTimestamp) ? new Date(firstObservedTimestamp).toISOString() : null;
  artifact.lastObservedTimestamp = Number.isFinite(lastObservedTimestamp) ? new Date(lastObservedTimestamp).toISOString() : null;
  artifact.rawFirstObservedTimestamp = Number.isFinite(bounds.rawFirstObservedTimestamp) ? new Date(bounds.rawFirstObservedTimestamp).toISOString() : null;
  artifact.rawLastObservedTimestamp = Number.isFinite(bounds.rawLastObservedTimestamp) ? new Date(bounds.rawLastObservedTimestamp).toISOString() : null;
  artifact.postLifecycleRowsExcluded = bounds.postLifecycleRowsExcluded;
  if (Number.isFinite(cutoff)) artifact.postLifecycleObservationPolicy = 'rows-at-or-after-delivery-or-delist-excluded-from-tradable-window';
  return artifact;
}

const manifestFile = path.join(ROOT, 'manifest.json');
const exchangeInfoFile = path.join(ROOT, 'source', 'current-exchangeInfo.json');
const lifecycleFile = path.join(ROOT, 'source', 'historical-lifecycle-evidence.json');
const archiveIndexFile = path.join(ROOT, 'source', 'archive-index.json');
if (!fs.existsSync(manifestFile) || !fs.existsSync(exchangeInfoFile)) throw new Error('Existing formal dataset manifest and current exchangeInfo evidence are required');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const exchangeInfo = JSON.parse(fs.readFileSync(exchangeInfoFile, 'utf8'));
const archiveIndex = fs.existsSync(archiveIndexFile) ? JSON.parse(fs.readFileSync(archiveIndexFile, 'utf8')) : null;
const currentSymbols = new Map((exchangeInfo.symbols || [])
  .filter(item => item.quoteAsset === 'USDT' && ['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(item.contractType))
  .map(item => [item.symbol, item]));
const evidence = loadEvidence(lifecycleFile);
const exchangeInfoEvidence = {
  path: path.relative(APP_DIR, exchangeInfoFile).replaceAll('\\', '/'),
  sha256: sha256File(exchangeInfoFile),
  url: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  source: 'Binance USD-M exchangeInfo snapshot',
};
const archiveIndexEvidence = fs.existsSync(archiveIndexFile)
  ? {path: path.relative(APP_DIR, archiveIndexFile).replaceAll('\\', '/'), sha256: sha256File(archiveIndexFile)}
  : null;
const end = timeValue(manifest.snapshotTimestamp);
const start = timeValue(manifest.universe.backtestStart);
const existingSymbols = manifest.universe.symbols || [];
const historicalSymbols = new Set((manifest.universe.markets || [])
  .filter(market => market?.historicalDelisted === true)
  .map(market => market.symbol));
const priceArtifacts = (manifest.artifacts || []).filter(item => item.kind === 'price');
const minuteArtifacts = (manifest.artifacts || []).filter(item => item.kind === 'minute');
const priceBySymbol = new Map();
const minuteBySymbol = new Map();
function lifecycleCutoffFor(symbol) {
  const currentMarket = currentSymbols.get(symbol);
  const delivery = timeValue(currentMarket?.deliveryDate);
  if (Number.isFinite(delivery) && delivery > 0 && delivery < end) return delivery;
  const externalDelist = evidence[symbol]?.delistEvidenceExact === true
    ? timeValue(evidence[symbol]?.delistEvidenceTimestamp)
    : NaN;
  return Number.isFinite(externalDelist) && externalDelist > 0 && externalDelist < end ? externalDelist : null;
}
for (const artifact of priceArtifacts) {
  const cutoff = lifecycleCutoffFor(artifact.symbol);
  priceBySymbol.set(artifact.symbol, await observedSummaryFor(artifact, {scan: Boolean(cutoff), cutoff}));
}
for (const artifact of minuteArtifacts) {
  const cutoff = lifecycleCutoffFor(artifact.symbol);
  minuteBySymbol.set(artifact.symbol, await observedSummaryFor(artifact, {scan: historicalSymbols.has(artifact.symbol) || Boolean(cutoff), cutoff}));
}
const minuteSymbols = new Set((manifest.artifacts || []).filter(item => item.kind === 'minute' && Number(item.rows) > 0).map(item => item.symbol));
const exclusionCandidates = [...new Set([
  ...existingSymbols,
  ...currentSymbols.keys(),
])];
const excludedMarkets = exclusionCandidates.filter(symbol => {
  const market = currentSymbols.get(symbol);
  return market?.status === 'PENDING_TRADING' && !priceBySymbol.has(symbol) && !minuteSymbols.has(symbol);
}).map(symbol => ({
  symbol,
  reason: 'pending-trading-without-price-or-minute-artifact',
  evidencePath: path.relative(APP_DIR, exchangeInfoFile).replaceAll('\\', '/'),
  evidenceUrl: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  evidenceSha256: exchangeInfoEvidence.sha256,
  status: currentSymbols.get(symbol)?.status || null,
  contractType: currentSymbols.get(symbol)?.contractType || null,
  archiveKeys: archiveIndex?.actualArchiveKeysBySymbol?.[symbol]
    || manifest.universe.excludedMarkets?.find(item => item.symbol === symbol)?.archiveKeys
    || null,
  archiveIndexPath: archiveIndexEvidence?.path || null,
  archiveIndexSha256: archiveIndexEvidence?.sha256 || null,
}));
const excludedSymbolSet = new Set(excludedMarkets.map(item => item.symbol));
const includedSymbols = existingSymbols.filter(symbol => !excludedSymbolSet.has(symbol));
const markets = includedSymbols.map(symbol => {
  const previous = (manifest.universe.markets || []).find(item => item.symbol === symbol) || {};
  const price = priceBySymbol.get(symbol);
  const minute = minuteBySymbol.get(symbol);
  const archiveFirst = previous.actualFirstArchiveMonth || previous.archiveFirstMonth;
  const archiveLast = previous.actualLastArchiveMonth || previous.archiveLastMonth;
  return lifecycleFromEvidence(symbol, {
    start,
    end,
    currentMarket: currentSymbols.get(symbol),
    priceSummary: {
      firstTimestamp: price?.firstTimestamp || previous.firstObserved,
      lastTimestamp: price?.lastTimestamp || previous.lastObserved,
      firstObservedTimestamp: minute?.firstObservedTimestamp || price?.firstObservedTimestamp,
      lastObservedTimestamp: minute?.lastObservedTimestamp || price?.lastObservedTimestamp,
      rawFirstObservedTimestamp: minute?.rawFirstObservedTimestamp || price?.rawFirstObservedTimestamp,
      rawLastObservedTimestamp: minute?.rawLastObservedTimestamp || price?.rawLastObservedTimestamp,
      postLifecycleRowsExcluded: minute?.postLifecycleRowsExcluded || price?.postLifecycleRowsExcluded || 0,
      postLifecycleObservationPolicy: minute?.postLifecycleObservationPolicy || price?.postLifecycleObservationPolicy || null,
    },
    archiveWindowValue: {
      firstMonth: archiveFirst || null,
      lastMonth: archiveLast || null,
      firstMonthStart: monthStart(archiveFirst),
      lastMonthEnd: monthEnd(archiveLast),
    },
    lifecycleEvidence: evidence,
    exchangeInfoEvidence,
  });
});
const marketBySymbol = new Map(markets.map(market => [market.symbol, market]));
manifest.artifacts = (manifest.artifacts || []).filter(artifact => !excludedSymbolSet.has(artifact.symbol));
for (const artifact of manifest.artifacts || []) {
  const market = marketBySymbol.get(artifact.symbol);
  if (market) {
    artifact.activeStart = market.activeStart;
    artifact.activeEnd = market.activeEnd;
  }
}
const historical = markets.filter(market => market.historicalDelisted);
const lifecycleGate = markets.length === includedSymbols.length && markets.every(market => market.lifecycleExact === true);
manifest.universe.symbols = includedSymbols;
manifest.universe.excludedMarkets = excludedMarkets;
manifest.universe.markets = markets;
manifest.universe.currentExchangeInfoEvidence = exchangeInfoEvidence.path;
manifest.universe.currentExchangeInfoSha256 = exchangeInfoEvidence.sha256;
manifest.universe.archiveIndexEvidence = archiveIndexEvidence;
manifest.universe.historicalLifecycleEvidence = fs.existsSync(lifecycleFile)
  ? {path: path.relative(APP_DIR, lifecycleFile).replaceAll('\\', '/'), sha256: sha256File(lifecycleFile)}
  : null;
manifest.universe.pointInTime = lifecycleGate;
manifest.universe.historicalDelistingsResolved = lifecycleGate && historical.every(market => market.historicalDelistEvidence === true);
manifest.universe.expandedNonCoreCovered = false;
manifest.status = 'M4-INCOMPLETE';
manifest.retrievedAt = new Date().toISOString();
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  manifest: path.relative(APP_DIR, manifestFile).replaceAll('\\', '/'),
  symbols: markets.length,
  currentSymbols: markets.filter(market => !market.historicalDelisted).length,
  historicalSymbols: historical.length,
  lifecycleExact: markets.filter(market => market.lifecycleExact).length,
  unresolvedLifecycle: markets.filter(market => !market.lifecycleExact).map(market => market.symbol),
  pointInTime: manifest.universe.pointInTime,
  historicalDelistingsResolved: manifest.universe.historicalDelistingsResolved,
  core: markets.filter(market => CORE_MARKETS.has(market.symbol)).length,
  expanded: markets.filter(market => !CORE_MARKETS.has(market.symbol)).length,
}, null, 2));
