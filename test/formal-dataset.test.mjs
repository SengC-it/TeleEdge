import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isUsdtPerpetualArchiveSymbol,
  monthKeys,
  parseArchiveKey,
  parseChecksum,
  parseS3List,
} from '../scripts/build-formal-dataset.mjs';

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
    {key: 'data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2022-04.zip', symbol: 'ETHUSDT', kind: 'price', interval: '1h', month: '2022-04'},
  );
  assert.deepEqual(
    parseArchiveKey('data/futures/um/monthly/fundingRate/ETHUSDT/ETHUSDT-fundingRate-2022-04.zip'),
    {key: 'data/futures/um/monthly/fundingRate/ETHUSDT/ETHUSDT-fundingRate-2022-04.zip', symbol: 'ETHUSDT', kind: 'funding', interval: 'event', month: '2022-04'},
  );
  assert.equal(parseArchiveKey('data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2022-04.zip.CHECKSUM'), null);
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
