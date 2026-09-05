import crypto from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
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
  const args = {root: DEFAULT_ROOT, pageSize: 50, delayMs: 250, concurrency: 6, symbols: null};
  for (const value of process.argv.slice(2)) {
    const [key, raw] = value.split('=', 2);
    if (key === '--root' && raw) args.root = path.resolve(raw);
    // The public CMS currently accepts at most 50 articles per page.
    // Clamp caller input so a larger value cannot turn a valid crawl into a
    // server-side 400.
    if (key === '--page-size' && raw) args.pageSize = Math.min(50, Math.max(1, Number(raw)));
    if (key === '--delay-ms' && raw) args.delayMs = Math.max(0, Number(raw));
    if (key === '--concurrency' && raw) args.concurrency = Math.min(12, Math.max(1, Number(raw)));
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
    // Binance's CMS endpoint rejects the default PowerShell user agent and
    // returns a misleading 400. Keep the request contract identical to the
    // non-Windows client, including the browser-like language/referrer
    // headers required by the public announcement API.
    const command = `(Invoke-WebRequest -Uri '${escapedUrl}' -Headers @{'Accept'='application/json';'Accept-Language'='en';'lang'='en';'Referer'='https://www.binance.com/en/support/announcement';'User-Agent'='TeleEdge-formal-dataset/1.0'} -UseBasicParsing -TimeoutSec 120).Content`;
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

async function fetchJsonWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await sleep(250 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function fetchCatalog(catalogId, pageSize, delayMs, concurrency) {
  const page = async pageNo => {
    const url = new URL(LIST_ENDPOINT);
    url.searchParams.set('type', '1');
    url.searchParams.set('catalogId', String(catalogId));
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('pageSize', String(pageSize));
    const payload = await fetchJsonWithRetry(url);
    const catalog = payload.data?.catalogs?.[0];
    return {total: Number(catalog?.total) || 0, articles: Array.isArray(catalog?.articles) ? catalog.articles : []};
  };
  const first = await page(1);
  const total = first.total || first.articles.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rest = pageCount > 1
    ? await mapConcurrent(Array.from({length: pageCount - 1}, (_, index) => index + 2), Math.min(4, concurrency), async pageNo => {
      if (delayMs) await sleep(delayMs);
      return page(pageNo);
    })
    : [];
  const articles = [first, ...rest].flatMap(result => result.articles);
  return {catalogId, total, articles};
}

function symbolBase(symbol) {
  return String(symbol).replace(/USDT$/, '');
}

function tokenPattern(value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i');
}

export function articleMentionsSymbol(article, symbol, bodyText = '') {
  const embeddedBody = [article?.body, article?.content, article?.description].filter(value => typeof value === 'string').join(' ');
  const text = `${article?.title || ''} ${embeddedBody} ${bodyText}`.toUpperCase();
  const full = String(symbol).toUpperCase();
  if (tokenPattern(full).test(text)) return true;
  const base = symbolBase(full);
  // A base token by itself is ambiguous (spot, margin, Launchpool, etc.).
  // Only accept an explicit pair spelling as a secondary form.
  return base.length >= 3 && new RegExp(`(^|[^A-Z0-9])${base}(?:[/_-])USDT([^A-Z0-9]|$)`, 'i').test(text);
}

export function isUsdtPerpetualAnnouncement(article, bodyText = '', kind = 'listing') {
  const embeddedBody = [article?.body, article?.content, article?.description].filter(value => typeof value === 'string').join(' ');
  const text = `${article?.title || ''} ${embeddedBody} ${bodyText}`.toUpperCase();
  if (/QUARTERLY|DELIVERY CONTRACT|COIN.?MARGINED|COIN.?M|\bSPOT\b|\bMARGIN\b|LAUNCHPOOL|EARN|CONVERT|COPY.?TRADING|OPTIONS?/.test(text)) return false;
  if (kind === 'delist' && !/DELIST|DELIVER/.test(text)) return false;
  const perpetual = /PERPETUAL|\bPERP\b/.test(text);
  const usdM = /USD.?Ⓢ?.?M|USDT.?M|USDT.?MARGINED|USDT/.test(text);
  return perpetual && usdM;
}

export function dedupeAnnouncements(articles) {
  const byKey = new Map();
  for (const article of Array.isArray(articles) ? articles : []) {
    const key = article?.code || `${article?.releaseDate || ''}:${article?.title || ''}`;
    if (!byKey.has(key)) byKey.set(key, article);
  }
  return [...byKey.values()].sort((a, b) => Number(a?.releaseDate || 0) - Number(b?.releaseDate || 0));
}

export function lifecycleArticleMatches(articles, symbol, kind) {
  return dedupeAnnouncements((Array.isArray(articles) ? articles : []).filter(article => articleMentionsSymbol(article, symbol) && isUsdtPerpetualAnnouncement(article, '', kind)));
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

export function timeCandidates(text) {
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

export function articleEventTime(article, bodyText, symbol, kind) {
  const text = `${bodyText} ${article.title}`;
  const symbolPattern = new RegExp(String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
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
  const payload = await fetchJsonWithRetry(url);
  await sleep(delayMs);
  return payload;
}

async function mapConcurrent(items, concurrency, mapper) {
  const values = Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      values[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, () => worker()));
  return values;
}

async function main() {
  const args = parseArgs();
  const manifestFile = path.join(args.root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`Manifest is absent: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const archiveIndexFile = path.join(args.root, 'source', 'archive-index.json');
  const archiveIndex = fs.existsSync(archiveIndexFile) ? JSON.parse(fs.readFileSync(archiveIndexFile, 'utf8')) : null;
  const symbols = [...new Set([
    ...(Array.isArray(manifest.universe?.symbols) ? manifest.universe.symbols : []),
    ...(Array.isArray(archiveIndex?.symbolsWithActualArchives) ? archiveIndex.symbolsWithActualArchives : []),
  ])].sort();
  if (!symbols.length) throw new Error('Manifest universe is empty');
  const existingFile = path.join(args.root, 'source', 'historical-lifecycle-evidence.json');
  const existingPayload = fs.existsSync(existingFile) ? JSON.parse(fs.readFileSync(existingFile, 'utf8')) : null;
  const existingBySymbol = new Map((Array.isArray(existingPayload?.markets) ? existingPayload.markets : [])
    .filter(record => record?.symbol)
    .map(record => [record.symbol, record]));
  const targetSymbols = args.symbols?.size
    ? symbols.filter(symbol => args.symbols.has(symbol))
    : symbols.filter(symbol => existingBySymbol.get(symbol)?.lifecycleExact !== true);
  const [listingCatalog, delistCatalog] = await Promise.all([
    fetchCatalog(CATALOGS.listing, args.pageSize, args.delayMs, args.concurrency),
    fetchCatalog(CATALOGS.delist, args.pageSize, args.delayMs, args.concurrency),
  ]);
  const sourceRoot = path.join(args.root, 'source', 'lifecycle');
  await fs.promises.mkdir(path.join(sourceRoot, 'listing'), {recursive: true});
  await fs.promises.mkdir(path.join(sourceRoot, 'delist'), {recursive: true});
  const records = symbols.map(symbol => existingBySymbol.get(symbol) || {symbol, listingCatalogId: CATALOGS.listing, delistCatalogId: CATALOGS.delist});
  const recordBySymbol = new Map(records.map(record => [record.symbol, record]));
  const processedRecords = await mapConcurrent(targetSymbols, args.concurrency, async symbol => {
    const listingMatches = lifecycleArticleMatches(listingCatalog.articles, symbol, 'listing');
    const delistMatches = lifecycleArticleMatches(delistCatalog.articles, symbol, 'delist');
    const record = {...(recordBySymbol.get(symbol) || {}), symbol, listingCatalogId: CATALOGS.listing, delistCatalogId: CATALOGS.delist};
    const collectEvidence = async (kind, articles) => {
      // The outer pool is the global detail-request limit. Keep this inner
      // mapping serial so concurrency cannot multiply across symbols.
      const output = (await mapConcurrent(articles, 1, async article => {
      const detailFile = path.join(sourceRoot, kind, `${article.code}.json`);
      let detail = null;
      let detailRaw = null;
      if (fs.existsSync(detailFile)) {
        try {
          detailRaw = fs.readFileSync(detailFile);
          detail = JSON.parse(detailRaw.toString('utf8'));
        } catch {
          detail = null;
          detailRaw = null;
        }
      }
      if (!detail) {
        detail = await detailFor(article, args.delayMs);
        detailRaw = Buffer.from(JSON.stringify(detail));
        await fs.promises.writeFile(detailFile, detailRaw);
      }
      const detailSha256 = sha256(detailRaw);
      const bodyText = textFromBody(detail.data?.body);
      const event = articleEventTime(article, bodyText, symbol, kind);
      if (!event) return null;
      return {
        timestamp: event.timestamp,
        precision: event.precision,
        source: `Binance official announcement catalog ${kind === 'listing' ? CATALOGS.listing : CATALOGS.delist}`,
        url: announcementUrl(kind, article.code),
        path: path.relative(APP_DIR, detailFile).replaceAll('\\', '/'),
        sha256: detailSha256,
        articleCode: article.code,
        articleTitle: article.title,
        articleReleaseDate: article.releaseDate,
      };
      })).filter(Boolean);
      return output;
    };
    const listingEvidence = await collectEvidence('listing', listingMatches);
    const delistEvidence = await collectEvidence('delist', delistMatches);
    const episodes = buildLifecycleEpisodes(listingEvidence, delistEvidence);
    record.activeEpisodes = episodes;
    const firstListing = episodes.find(row => row.listingEvidenceTimestamp);
    const lastDelist = [...episodes].reverse().find(row => row.delistEvidenceTimestamp);
    if (firstListing) {
      Object.assign(record, {
        listingEvidenceTimestamp: firstListing.listingEvidenceTimestamp,
        listingEvidenceExact: firstListing.listingEvidenceExact,
        listingEvidenceSource: firstListing.listingEvidenceSource,
        listingEvidenceUrl: firstListing.listingEvidenceUrl,
        listingEvidencePath: firstListing.listingEvidencePath,
        listingEvidenceSha256: firstListing.listingEvidenceSha256,
        listingArticleCode: firstListing.episodeId,
      });
    }
    if (lastDelist) {
      Object.assign(record, {
        delistEvidenceTimestamp: lastDelist.delistEvidenceTimestamp,
        delistEvidenceExact: lastDelist.delistEvidenceExact,
        delistEvidenceSource: lastDelist.delistEvidenceSource,
        delistEvidenceUrl: lastDelist.delistEvidenceUrl,
        delistEvidencePath: lastDelist.delistEvidencePath,
        delistEvidenceSha256: lastDelist.delistEvidenceSha256,
        delistArticleCode: lastDelist.episodeId,
      });
    }
    record.listingMatches = listingMatches.length;
    record.delistMatches = delistMatches.length;
    return record;
  });
  for (const record of processedRecords) recordBySymbol.set(record.symbol, record);
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

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

export function buildLifecycleEpisodes(listingEvidence = [], delistEvidence = []) {
  const listings = [...listingEvidence].filter(row => Number.isFinite(Number(row?.timestamp)))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || String(a.articleCode || '').localeCompare(String(b.articleCode || '')));
  const delists = [...delistEvidence].filter(row => Number.isFinite(Number(row?.timestamp)))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || String(a.articleCode || '').localeCompare(String(b.articleCode || '')));
  const usedDelists = new Set();
  const episodes = listings.map((listing, index) => {
    const nextListing = listings[index + 1];
    const matchIndex = delists.findIndex((delist, delistIndex) => !usedDelists.has(delistIndex)
      && Number(delist.timestamp) > Number(listing.timestamp)
      && (!nextListing || Number(delist.timestamp) < Number(nextListing.timestamp)));
    const delist = matchIndex >= 0 ? delists[matchIndex] : null;
    if (matchIndex >= 0) usedDelists.add(matchIndex);
    return {
      episodeId: `${listing.articleCode || 'listing'}-${delist?.articleCode || 'open'}`,
      listingTime: listing.timestamp,
      delistTime: delist?.timestamp ?? null,
      listingEvidenceTimestamp: isoTimestamp(listing.timestamp),
      listingEvidenceExact: listing.precision === 'minute',
      listingEvidenceSource: listing.source,
      listingEvidenceUrl: listing.url,
      listingEvidencePath: listing.path,
      listingEvidenceSha256: listing.sha256,
      delistEvidenceTimestamp: delist ? isoTimestamp(delist.timestamp) : null,
      delistEvidenceExact: delist?.precision === 'minute',
      delistEvidenceSource: delist?.source || null,
      delistEvidenceUrl: delist?.url || null,
      delistEvidencePath: delist?.path || null,
      delistEvidenceSha256: delist?.sha256 || null,
    };
  });
  for (let index = 0; index < delists.length; index++) {
    if (usedDelists.has(index)) continue;
    const delist = delists[index];
    episodes.push({
      episodeId: `unmatched-${delist.articleCode || index}`,
      delistTime: delist.timestamp,
      delistEvidenceTimestamp: isoTimestamp(delist.timestamp),
      delistEvidenceExact: delist.precision === 'minute',
      delistEvidenceSource: delist.source,
      delistEvidenceUrl: delist.url,
      delistEvidencePath: delist.path,
      delistEvidenceSha256: delist.sha256,
    });
  }
  return episodes.sort((a, b) => Number(a.listingTime ?? a.delistTime) - Number(b.listingTime ?? b.delistTime));
}

function isoTimestamp(value) {
  return Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : null;
}
