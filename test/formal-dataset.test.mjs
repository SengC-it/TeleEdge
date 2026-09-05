import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archivesBySymbolFromKeys,
  createSerializedProgressWriter,
  isUsdtPerpetualArchiveSymbol,
  lifecycleFromEvidence,
  monthKeys,
  normalizedRowsFromCsv,
  parseArchiveKey,
  parseChecksum,
  parseS3List,
} from '../scripts/build-formal-dataset.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('formal dataset archive discovery parses paginated S3 evidence', () => {
  const page = parseS3List(`
    <ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>next&amp;token</NextContinuationToken>
      <Contents><Key>data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2021-01.zip</Key></Contents>
      <CommonPrefixes><Prefix>data/futures/um/monthly/klines/BTCUSDT/</Prefix></CommonPrefixes>
    </ListBucketResult>
  `);
  assert.deepEqual(page.keys, ['data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2021-01.zip']);
  assert.deepEqual(page.prefixes, ['data/futures/um/monthly/klines/BTCUSDT/']);
  assert.equal(page.isTruncated, true);
  assert.equal(page.nextContinuationToken, 'next&token');
});

test('formal dataset accepts only bare USDT perpetual archive symbols', () => {
  assert.equal(isUsdtPerpetualArchiveSymbol('BTCUSDT'), true);
  assert.equal(isUsdtPerpetualArchiveSymbol('1000PEPEUSDT'), true);
  assert.equal(isUsdtPerpetualArchiveSymbol('BTCUSDT_210326'), false);
  assert.equal(isUsdtPerpetualArchiveSymbol('BTCUSDTSETTLED'), false);
  assert.equal(isUsdtPerpetualArchiveSymbol('BTCBUSD'), false);
});

test('formal dataset parses kline and funding archive keys without current exchangeInfo', () => {
  assert.deepEqual(
    parseArchiveKey('data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2022-04.zip'),
    {key: 'data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2022-04.zip', symbol: 'ETHUSDT', kind: 'price', interval: '1h', month: '2022-04', cadence: 'monthly'},
  );
  assert.deepEqual(
    parseArchiveKey('data/futures/um/monthly/fundingRate/ETHUSDT/ETHUSDT-fundingRate-2022-04.zip'),
    {key: 'data/futures/um/monthly/fundingRate/ETHUSDT/ETHUSDT-fundingRate-2022-04.zip', symbol: 'ETHUSDT', kind: 'funding', interval: 'event', month: '2022-04', cadence: 'monthly'},
  );
  assert.equal(parseArchiveKey('data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2022-04.zip.CHECKSUM'), null);
  assert.deepEqual(
    parseArchiveKey('data/futures/um/daily/klines/ETHUSDT/1m/ETHUSDT-1m-2022-04-03.zip'),
    {key: 'data/futures/um/daily/klines/ETHUSDT/1m/ETHUSDT-1m-2022-04-03.zip', symbol: 'ETHUSDT', kind: 'minute', interval: '1m', day: '2022-04-03', cadence: 'daily'},
  );
});

test('formal dataset month window is deterministic and excludes snapshot month', () => {
  assert.deepEqual(
    monthKeys(Date.parse('2021-01-01T00:00:00Z'), Date.parse('2021-04-01T00:00:00Z')),
    ['2021-01', '2021-02', '2021-03'],
  );
});

test('formal dataset parses Binance SHA256 sidecar format', () => {
  const parsed = parseChecksum('00de1eb2f3e3bc7f21b7ab321f1681385726fe7ba55306a7337acfd8f81fedfa  BTCUSDT-1h-2021-01.zip\n');
  assert.equal(parsed.sha256, '00de1eb2f3e3bc7f21b7ab321f1681385726fe7ba55306a7337acfd8f81fedfa');
  assert.equal(parsed.filename, 'BTCUSDT-1h-2021-01.zip');
});

test('formal dataset parses the real fundingRate CSV schema without treating interval as mark price', () => {
  const rows = normalizedRowsFromCsv(
    'calc_time,funding_interval_hours,last_funding_rate\n1609488000000,8,0.0001\n',
    'funding',
  );
  assert.deepEqual(rows, [{
    t: 1609488000000,
    rate: 0.0001,
    fundingIntervalHours: 8,
    markPrice: null,
  }]);
});

test('formal dataset lifecycle discovery uses actual archive months and keeps unresolved evidence non-PIT', () => {
  const archives = archivesBySymbolFromKeys({
    BTCUSDT: {
      klines: [
        'data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2021-02.zip',
        'data/futures/um/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2021-02.zip',
      ],
      funding: ['data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2021-02.zip'],
    },
  }, ['BTCUSDT'], Date.parse('2021-01-01T00:00:00Z'), Date.parse('2021-04-01T00:00:00Z'));
  const window = [archives.get('BTCUSDT').price[0], archives.get('BTCUSDT').minute[0], archives.get('BTCUSDT').funding[0]];
  const lifecycle = lifecycleFromEvidence('BTCUSDT', {
    start: Date.parse('2021-01-01T00:00:00Z'),
    end: Date.parse('2021-04-01T00:00:00Z'),
    currentMarket: null,
    priceSummary: {firstTimestamp: Date.parse('2021-02-01T00:00:00Z'), lastTimestamp: Date.parse('2021-03-01T00:00:00Z')},
    archiveWindowValue: {
      firstMonth: '2021-02',
      lastMonth: '2021-02',
      firstMonthStart: Date.parse('2021-02-01T00:00:00Z'),
      lastMonthEnd: Date.parse('2021-03-01T00:00:00Z'),
    },
    lifecycleEvidence: {},
  });
  assert.deepEqual(window.map(row => row.month), ['2021-02', '2021-02', '2021-02']);
  assert.equal(lifecycle.actualFirstArchiveMonth, '2021-02');
  assert.equal(lifecycle.actualLastArchiveMonth, '2021-02');
  assert.equal(lifecycle.lifecycleExact, false);
  assert.equal(lifecycle.listingEvidenceSource, null);
});

test('formal dataset lifecycle release requires timestamped listing and delist evidence', () => {
  const lifecycle = lifecycleFromEvidence('OLDUSDT', {
    start: Date.parse('2021-01-01T00:00:00Z'),
    end: Date.parse('2022-01-01T00:00:00Z'),
    currentMarket: null,
    priceSummary: {firstTimestamp: Date.parse('2021-02-01T00:00:00Z'), lastTimestamp: Date.parse('2021-11-30T23:00:00Z')},
    minuteSummary: {firstObservedTimestamp: Date.parse('2021-01-20T00:15:00Z'), lastObservedTimestamp: Date.parse('2021-11-30T23:59:00Z')},
    archiveWindowValue: {firstMonth: '2021-02', lastMonth: '2021-11', firstMonthStart: Date.parse('2021-02-01T00:00:00Z'), lastMonthEnd: Date.parse('2021-12-01T00:00:00Z')},
    lifecycleEvidence: {
      OLDUSDT: {
        onboardTime: '2021-01-20T00:00:00Z',
        delistTime: '2021-12-01T00:00:00Z',
        listingEvidenceSource: 'Binance delisting archive',
        listingEvidenceUrl: 'https://www.binance.com/en/support/announcement/listing-oldusdt',
        listingEvidenceSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        delistEvidenceSource: 'Binance delisting archive',
        delistEvidenceUrl: 'https://www.binance.com/en/support/announcement/delist-oldusdt',
        delistEvidenceSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    },
  });
  assert.equal(lifecycle.lifecycleExact, true);
  assert.equal(lifecycle.listingEvidenceSource, 'Binance delisting archive');
  assert.equal(lifecycle.delistEvidenceSource, 'Binance delisting archive');
  assert.equal(lifecycle.historicalDelistEvidence, true);
});

test('formal dataset lifecycle evidence conflicts never become exact', () => {
  const base = {
    listingEvidenceSource: 'Binance lifecycle evidence',
    listingEvidenceUrl: 'https://example.invalid/listing',
    listingEvidenceSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    delistEvidenceSource: 'Binance lifecycle evidence',
    delistEvidenceUrl: 'https://example.invalid/delist',
    delistEvidenceSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const listingConflict = lifecycleFromEvidence('CONFLICT1USDT', {
    start: Date.parse('2021-01-01T00:00:00Z'),
    end: Date.parse('2022-01-01T00:00:00Z'),
    currentMarket: null,
    priceSummary: {firstTimestamp: Date.parse('2021-02-01T00:00:00Z'), lastTimestamp: Date.parse('2021-11-30T23:00:00Z')},
    minuteSummary: {firstObservedTimestamp: Date.parse('2021-02-01T00:00:00Z'), lastObservedTimestamp: Date.parse('2021-11-30T23:59:00Z')},
    archiveWindowValue: {firstMonth: '2021-02', lastMonth: '2021-11', firstMonthStart: Date.parse('2021-02-01T00:00:00Z'), lastMonthEnd: Date.parse('2021-12-01T00:00:00Z')},
    lifecycleEvidence: {CONFLICT1USDT: {...base, listingEvidenceTimestamp: '2021-03-01T00:00:00Z', delistEvidenceTimestamp: '2021-12-01T00:00:00Z'}},
  });
  assert.equal(listingConflict.lifecycleExact, false);
  assert.ok(listingConflict.lifecycleConflictReasons.includes('listing-after-first-observed'));

  const delistConflict = lifecycleFromEvidence('CONFLICT2USDT', {
    start: Date.parse('2021-01-01T00:00:00Z'),
    end: Date.parse('2022-01-01T00:00:00Z'),
    currentMarket: null,
    priceSummary: {firstTimestamp: Date.parse('2021-02-01T00:00:00Z'), lastTimestamp: Date.parse('2021-11-30T23:00:00Z')},
    minuteSummary: {firstObservedTimestamp: Date.parse('2021-02-01T00:00:00Z'), lastObservedTimestamp: Date.parse('2021-11-30T23:59:00Z')},
    archiveWindowValue: {firstMonth: '2021-02', lastMonth: '2021-11', firstMonthStart: Date.parse('2021-02-01T00:00:00Z'), lastMonthEnd: Date.parse('2021-12-01T00:00:00Z')},
    lifecycleEvidence: {CONFLICT2USDT: {...base, listingEvidenceTimestamp: '2021-01-20T00:00:00Z', delistEvidenceTimestamp: '2021-11-30T23:00:00Z'}},
  });
  assert.equal(delistConflict.lifecycleExact, false);
  assert.ok(delistConflict.lifecycleConflictReasons.includes('delist-at-or-before-last-observed'));
});

test('formal dataset progress writes are serialized and resume-safe under concurrent updates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleedge-progress-'));
  const file = path.join(root, 'progress.json');
  const writer = createSerializedProgressWriter(file, {existing: {done: true}});
  await Promise.all(Array.from({length: 20}, (_, index) => writer.update({[`symbol-${index}`]: {rows: index + 1}})));
  await writer.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(saved).length, 21);
  assert.equal(saved['symbol-19'].rows, 20);
  const resumed = createSerializedProgressWriter(file, saved);
  await resumed.update({resumed: {done: true}});
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).resumed.done, true);
});
