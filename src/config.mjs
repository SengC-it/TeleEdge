import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const H1 = 3_600_000;
export const H4 = 4 * H1;
export const DAY = 24 * H1;

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, '..');
export const WORKSPACE_DIR = path.resolve(APP_DIR, '..');
export const RUNTIME_DIR = path.join(APP_DIR, 'runtime');

const envFile = path.join(APP_DIR, '.env');
if (fs.existsSync(envFile)) {
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] == null) process.env[key] = value;
  }
}

function numberEnv(name, fallback, {min = -Infinity, max = Infinity} = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

export const runtimeConfig = Object.freeze({
  mode: 'paper',
  equityUsdt: numberEnv('PAPER_EQUITY_USDT', 10_000, {min: 100}),
  httpHost: process.env.HTTP_HOST || '127.0.0.1',
  httpPort: numberEnv('HTTP_PORT', 8787, {min: 1, max: 65_535}),
  scanIntervalMs: numberEnv('SCAN_INTERVAL_MINUTES', 15, {min: 1, max: 240}) * 60_000,
  monitorIntervalMs: numberEnv('MONITOR_INTERVAL_SECONDS', 60, {min: 10, max: 3600}) * 1000,
  signalMaxAgeMs: numberEnv('SIGNAL_MAX_AGE_MINUTES', 30, {min: 1, max: 240}) * 60_000,
  requestConcurrency: numberEnv('BINANCE_REQUEST_CONCURRENCY', 5, {min: 1, max: 10}),
  requestDelayMs: numberEnv('BINANCE_REQUEST_DELAY_MS', 80, {min: 0, max: 2000}),
  webhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
  offline: process.env.TELE_OFFLINE === '1',
});

export const modelConfig = Object.freeze({
  version: 'V7.5-cap10-risk60-same3',
  cap: 10,
  maxPerSide: 8,
  sameTimePerSide: 3,
  riskFraction: 0.006,
  totalRisk: 0.06,
  cooldownMs: 72 * H1,
  stressRoundTripCost: 0.0015,
  maxGrossLeverage: 3,
});

export const CORE_MARKETS = new Set([
  'AAVEUSDT', 'ADAUSDT', 'AGLDUSDT', 'ALGOUSDT', 'ALLOUSDT', 'APTUSDT',
  'ARBUSDT', 'ASTERUSDT', 'AVAXUSDT', 'BCHUSDT', 'BEATUSDT', 'BNBUSDT',
  '1000BONKUSDT', 'BTCUSDT', 'DASHUSDT', 'DOGEUSDT', 'DOTUSDT', 'EIGENUSDT',
  'ENAUSDT', 'ETCUSDT', 'ETHUSDT', 'FARTCOINUSDT', 'FILUSDT', 'GLMUSDT',
  'GRASSUSDT', 'HUSDT', 'HBARUSDT', 'HYPEUSDT', 'INJUSDT', 'JTOUSDT',
  'JUPUSDT', 'KAITOUSDT', 'KGENUSDT', 'LABUSDT', 'LINKUSDT', 'LITUSDT',
  'LTCUSDT', 'MMTUSDT', 'MSTRUSDT', 'NEARUSDT', 'ONDOUSDT', 'OPUSDT',
  'PENGUUSDT', '1000PEPEUSDT', 'PIEVERSEUSDT', 'RAVEUSDT', 'RENDERUSDT',
  'SUSDT', 'SEIUSDT', '1000SHIBUSDT', 'SNDKUSDT', 'SOLUSDT', 'STXUSDT',
  'SUIUSDT', 'SYRUPUSDT', 'TAOUSDT', 'TIAUSDT', 'TRUMPUSDT', 'TRXUSDT',
  'UNIUSDT', 'VIRTUALUSDT', 'WIFUSDT', 'WLDUSDT', 'WLFIUSDT', 'XAGUSDT',
  'XAUUSDT', 'XLMUSDT', 'XPLUSDT', 'XRPUSDT', 'ZECUSDT',
]);

// Frozen development estimates from v74_dual_alpha_barbell_analysis.json.
// V7.5 changed capacity/risk only; its signal selector is identical to V7.4.
export const LONG_SLEEVES = Object.freeze({
  expanded: {targetR: 2, n: 53, mean: 0.6566271611465045, lcb90: 0.39774417899478093},
  core: {targetR: 2, n: 306, mean: 0.487856733621996, lcb90: 0.3794563977981343},
});

export const SHORT_SEGMENTS = Object.freeze([
  {
    id: 'funding-breadth-minus10-to-0', family: 'fundingCrowdingReversal', targetR: 1.5,
    feature: 'breadthMomentum5d', min: -0.1, max: 0,
    n: 77, mean: 0.5425502254706844, lcb90: 0.36551350071043354,
  },
  {
    id: 'funding-volume-gte200m', family: 'fundingCrowdingReversal', targetR: 1.5,
    feature: 'dayVolume', min: 200_000_000, max: Infinity,
    n: 58, mean: 0.24441156266925573, lcb90: 0.03413067293733266,
  },
  {
    id: 'shock-volume-50-to-200m', family: 'volumeShockReversal', targetR: 1.5,
    feature: 'dayVolume', min: 50_000_000, max: 200_000_000,
    n: 141, mean: 0.17594210898154714, lcb90: 0.04089951234156186,
  },
  {
    id: 'shock-btc-strength-0-to-20', family: 'volumeShockReversal', targetR: 1.5,
    feature: 'btcRouterStrength', min: 0, max: 0.2,
    n: 133, mean: 0.2049284641968539, lcb90: 0.06586850310536216,
  },
  {
    id: 'shock-volume-ratio-gte5', family: 'volumeShockReversal', targetR: 2,
    feature: 'volumeRatio', min: 5, max: Infinity,
    n: 178, mean: 0.17316054103044048, lcb90: 0.03243004980966105,
  },
  {
    id: 'shock-btc-strength-0-to-20-2r', family: 'volumeShockReversal', targetR: 2,
    feature: 'btcRouterStrength', min: 0, max: 0.2,
    n: 133, mean: 0.22522904342527966, lcb90: 0.06082927924691034,
  },
]);
