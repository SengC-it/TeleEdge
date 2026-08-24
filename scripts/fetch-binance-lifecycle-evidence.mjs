import crypto from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_ROOT = path.join(APP_DIR, 'data', 'backtest');
const API_HOST = 'https://www.binance.com';
const LIST_ENDPOINT = `${API_HOST}/bapi/apex/v1/public/apex/cms/article/list/query`;
const DETAIL_ENDPOINT = `${API_HOST}/bapi/composite/v1/public/cms/article/detail/query`;
const CATALOGS = Object.freeze({listing: 48, delist: 161});
const execFile = promisify(execFileCallback);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs() {
  const args = {root: DEFAULT_ROOT, pageSize: 50, delayMs: 250, symbols: null};
  for (const value of process.argv.slice(2)) {
    const [key, raw] = value.split('=', 2);
    if (key === '--root' && raw) args.root = path.resolve(raw);
    if (key === '--page-size' && raw) args.pageSize = Math.min(100, Math.max(1, Number(raw)));
    if (key === '--delay-ms' && raw) args.delayMs = Math.max(0, Number(raw));
    if (key === '--symbols' && raw) args.symbols = new Set(raw.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean));
  }
  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  if (process.platform === 'win32') {
    const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const escapedUrl = String(url).replaceAll("'", "''");
    const command = `(Invoke-WebRequest -Uri '${escapedUrl}' -UseBasicParsing -TimeoutSec 120).Content`;
    const {stdout} = await execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    return JSON.parse(stdout);
  }
  const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args = [
    '-L', '--fail', '--silent', '--show-error', '--connect-timeout', '20', '--max-time', '120',
    '-H', 'Accept: application/json',
    '-H', 'Accept-Language: en',
    '-H', 'lang: en',
    '-H', 'Referer: https://www.binance.com/en/messages/v2/group/announcement',
    '-H', 'User-Agent: TeleEdge-formal-dataset/1.0',
    url,
  ];
  const {stdout} = await execFile(executable, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  return JSON.parse(stdout);
}

async function fetchCatalog(catalogId, pageSize, delayMs) {
  const articles = [];
  let pageNo = 1;
  let total = Infinity;
  while (articles.length < total) {
    const url = new URL(LIST_ENDPOINT);
    url.searchParams.set('type', '1');
    url.searchParams.set('catalogId', String(catalogId));
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('pageSize', String(pageSize));
    const payload = await fetchJson(url);
    const catalog = payload.data?.catalogs?.[0];
    const page = Array.isArray(catalog?.articles) ? catalog.articles : [];
    if (!page.length) break;
    articles.push(...page);
    total = Number(catalog.total) || articles.length;
    pageNo++;
    if (page.length < pageSize) break;
    await sleep(delayMs);
  }
  return {catalogId, total, articles};
}

function symbolBase(symbol) {
  return String(symbol).replace(/USDT$/, '');
}

function articleMentionsSymbol(article, symbol) {
  const title = String(article?.title || '').toUpperCase();
  const full = String(symbol).toUpperCase();
  if (new RegExp(`(^|[^A-Z0-9])${full.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}([^A-Z0-9]|$)`).test(title)) return true;
  const base = symbolBase(full);
  if (base.length < 3) return false;
  return new RegExp(`(^|[^A-Z0-9])${base}(USDT)?([^A-Z0-9]|$)`).test(title);
}

function textFromBody(body) {
  let parsed = body;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { return body; }
  }
  const result = [];
  const visit = value => {
    if (!value) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') result.push(value.text);
      for (const [key, child] of Object.entries(value)) if (key !== 'text') visit(child);
    }
  };
  visit(parsed);
  return result.join(' ');
}

function timeCandidates(text) {
  const values = [];
  const pattern = /(20\d{2}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?\s*(?:\(UTC\)|UTC)?/g;
  for (const match of String(text).matchAll(pattern)) {
    const date = match[1];
    const clock = match[2] || null;
    const timestamp = Date.parse(`${date}T${clock || '00:00:00'}Z`);
    if (!Number.isFinite(timestamp)) continue;
    values.push({timestamp, precision: clock ? 'minute' : 'date', raw: match[0]});
  }
  return values.filter((value, index, all) => index === all.findIndex(item => item.timestamp === value.timestamp && item.precision === value.precision));
}

function articleEventTime(article, bodyText, symbol, kind) {
  const text = `${bodyText} ${article.title}`;
  const symbolPattern = new RegExp(String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  for (const match of text.matchAll(symbolPattern)) {
    const before = text.slice(Math.max(0, match.index - 140), match.index);
    const after = text.slice(match.index + symbol.length, Math.min(text.length, match.index + symbol.length + 100));
    const beforeTimes = timeCandidates(before);
    if (beforeTimes.length) return {timestamp: beforeTimes.at(-1).timestamp, precision: beforeTimes.at(-1).precision};
    const afterTimes = timeCandidates(after);
    if (afterTimes.length) return {timestamp: afterTimes[0].timestamp, precision: afterTimes[0].precision};
  }
  const candidates = timeCandidates(article.title);
  if (!candidates.length) return null;
  const selected = candidates[0];
  return {
    timestamp: selected.timestamp,
    precision: selected.precision,
  };
}

function announcementUrl(kind, code) {
  return `${API_HOST}/en/support/announcement/${code}`;
}

async function detailFor(article, delayMs) {
  const url = new URL(DETAIL_ENDPOINT);
  url.searchParams.set('articleCode', article.code);
  const payload = await fetchJson(url);
  await sleep(delayMs);
  return payload;
}

async function main() {
  const args = parseArgs();
  const manifestFile = path.join(args.root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`Manifest is absent: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const symbols = Array.isArray(manifest.universe?.symbols) ? manifest.universe.symbols : [];
  if (!symbols.length) throw new Error('Manifest universe is empty');
  const existingFile = path.join(args.root, 'source', 'historical-lifecycle-evidence.json');
  const existingPayload = fs.existsSync(existingFile) ? JSON.parse(fs.readFileSync(existingFile, 'utf8')) : null;
  const existingBySymbol = new Map((Array.isArray(existingPayload?.markets) ? existingPayload.markets : [])
    .filter(record => record?.symbol)
    .map(record => [record.symbol, record]));
  const unresolvedTargets = new Set((manifest.universe?.markets || [])
    .filter(market => market?.lifecycleExact !== true)
    .map(market => market.symbol));
  const targetSymbols = args.symbols?.size
    ? symbols.filter(symbol => args.symbols.has(symbol))
    : unresolvedTargets.size ? symbols.filter(symbol => unresolvedTargets.has(symbol)) : symbols;
  const [listingCatalog, delistCatalog] = await Promise.all([
    fetchCatalog(CATALOGS.listing, args.pageSize, args.delayMs),
    fetchCatalog(CATALOGS.delist, args.pageSize, args.delayMs),
  ]);
  const sourceRoot = path.join(args.root, 'source', 'lifecycle');
  await fs.promises.mkdir(path.join(sourceRoot, 'listing'), {recursive: true});
  await fs.promises.mkdir(path.join(sourceRoot, 'delist'), {recursive: true});
  const records = symbols.map(symbol => existingBySymbol.get(symbol) || {symbol, listingCatalogId: CATALOGS.listing, delistCatalogId: CATALOGS.delist});
  const recordBySymbol = new Map(records.map(record => [record.symbol, record]));
  for (const symbol of targetSymbols) {
    const listingMatches = listingCatalog.articles.filter(article => articleMentionsSymbol(article, symbol)).sort((a, b) => Number(a.releaseDate) - Number(b.releaseDate));
    const delistMatches = delistCatalog.articles.filter(article => articleMentionsSymbol(article, symbol)).sort((a, b) => Number(b.releaseDate) - Number(a.releaseDate));
    const listingArticle = listingMatches[0] || null;
    const delistArticle = delistMatches[0] || null;
    const record = {...(recordBySymbol.get(symbol) || {}), symbol, listingCatalogId: CATALOGS.listing, delistCatalogId: CATALOGS.delist};
    for (const [kind, article] of [['listing', listingArticle], ['delist', delistArticle]]) {
      if (!article) continue;
      const detail = await detailFor(article, args.delayMs);
      const raw = Buffer.from(JSON.stringify(detail));
      const detailFile = path.join(sourceRoot, kind, `${article.code}.json`);
      await fs.promises.writeFile(detailFile, raw);
      const detailSha256 = sha256(raw);
      const bodyText = textFromBody(detail.data?.body);
      const event = articleEventTime(article, bodyText, symbol, kind);
      if (kind === 'listing') {
        record.listingEvidenceTimestamp = event ? new Date(event.timestamp).toISOString() : null;
        record.listingEvidenceExact = event?.precision === 'minute';
        record.listingEvidenceSource = `Binance official announcement catalog ${CATALOGS.listing}`;
        record.listingEvidenceUrl = announcementUrl(kind, article.code);
        record.listingEvidencePath = path.relative(APP_DIR, detailFile).replaceAll('\\', '/');
        record.listingEvidenceSha256 = detailSha256;
        record.listingArticleCode = article.code;
        record.listingArticleTitle = article.title;
        record.listingArticleReleaseDate = article.releaseDate;
      } else {
        record.delistEvidenceTimestamp = event ? new Date(event.timestamp).toISOString() : null;
        record.delistEvidenceExact = event?.precision === 'minute';
        record.delistEvidenceSource = `Binance official announcement catalog ${CATALOGS.delist}`;
        record.delistEvidenceUrl = announcementUrl(kind, article.code);
        record.delistEvidencePath = path.relative(APP_DIR, detailFile).replaceAll('\\', '/');
        record.delistEvidenceSha256 = detailSha256;
        record.delistArticleCode = article.code;
        record.delistArticleTitle = article.title;
        record.delistArticleReleaseDate = article.releaseDate;
      }
    }
    record.listingMatches = listingMatches.length;
    record.delistMatches = delistMatches.length;
    recordBySymbol.set(symbol, record);
  }
  const finalRecords = symbols.map(symbol => recordBySymbol.get(symbol));
  const unresolved = finalRecords.filter(record => !record?.listingEvidenceTimestamp || !record?.delistEvidenceTimestamp)
    .map(record => ({symbol: record.symbol, listingMatches: record.listingMatches ?? null, delistMatches: record.delistMatches ?? null}));
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshotEnd: manifest.snapshotTimestamp,
    source: 'Binance official announcement CMS API',
    sourceEndpoints: {
      listing: `${LIST_ENDPOINT}?type=1&catalogId=${CATALOGS.listing}&pageNo={pageNo}&pageSize={pageSize}`,
      delist: `${LIST_ENDPOINT}?type=1&catalogId=${CATALOGS.delist}&pageNo={pageNo}&pageSize={pageSize}`,
      detail: `${DETAIL_ENDPOINT}?articleCode={articleCode}`,
    },
    catalogs: {
      listing: {catalogId: CATALOGS.listing, total: listingCatalog.total, articles: listingCatalog.articles.length},
      delist: {catalogId: CATALOGS.delist, total: delistCatalog.total, articles: delistCatalog.articles.length},
    },
    markets: finalRecords,
    unresolved,
  };
  const outputFile = path.join(args.root, 'source', 'historical-lifecycle-evidence.json');
  const rawOutput = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
  await fs.promises.writeFile(outputFile, rawOutput);
  await fs.promises.writeFile(`${outputFile}.sha256`, `${sha256(rawOutput)}  ${path.basename(outputFile)}\n`);
  console.log(JSON.stringify({output: path.relative(APP_DIR, outputFile).replaceAll('\\', '/'), sha256: sha256(rawOutput), symbols: records.length, unresolved: unresolved.length, listingArticles: listingCatalog.articles.length, delistArticles: delistCatalog.articles.length}, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
