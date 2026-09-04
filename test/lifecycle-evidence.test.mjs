import assert from 'node:assert/strict';
import test from 'node:test';
import {
  articleEventTime,
  articleMentionsSymbol,
  dedupeAnnouncements,
  isUsdtPerpetualAnnouncement,
  lifecycleArticleMatches,
} from '../scripts/fetch-binance-lifecycle-evidence.mjs';

test('lifecycle matching searches title and detail body with symbol boundaries', () => {
  const article = {code: 'a1', title: 'New USDⓈ-M perpetual contract support'};
  assert.equal(articleMentionsSymbol(article, 'ABCUSDT', 'ABCUSDT will be listed on 2024-02-03 08:00 UTC'), true);
  assert.equal(articleMentionsSymbol(article, 'ABCDUSDT', 'ABCUSDT will be listed'), false);
});

test('lifecycle matching rejects non-perpetual delivery or coin-margined announcements', () => {
  const quarterly = {code: 'q1', title: 'Binance Futures will launch ABCUSDT Quarterly Contract'};
  const coinM = {code: 'c1', title: 'Binance Futures will list ABCUSD Coin-Margined Perpetual Contract'};
  assert.equal(isUsdtPerpetualAnnouncement(quarterly, '', 'listing'), false);
  assert.equal(isUsdtPerpetualAnnouncement(coinM, '', 'listing'), false);
  assert.equal(lifecycleArticleMatches([quarterly, coinM], 'ABCUSDT', 'listing').length, 0);
});

test('lifecycle announcement pagination duplicates are reduced by article code', () => {
  const articles = [
    {code: 'a2', releaseDate: 2, title: 'ABCUSDT USDⓈ-M Perpetual'},
    {code: 'a2', releaseDate: 2, title: 'ABCUSDT USDⓈ-M Perpetual'},
    {code: 'a1', releaseDate: 1, title: 'ABCUSDT USDⓈ-M Perpetual'},
  ];
  assert.deepEqual(dedupeAnnouncements(articles).map(row => row.code), ['a1', 'a2']);
});

test('delist matching requires a delist/delivery action and extracts detail timestamp', () => {
  const article = {code: 'd1', title: 'Binance Futures will delist ABCUSDT perpetual contract'};
  assert.equal(lifecycleArticleMatches([article], 'ABCUSDT', 'delist').length, 1);
  const event = articleEventTime(article, 'ABCUSDT perpetual trading will end at 2025-04-05 12:30 UTC', 'ABCUSDT', 'delist');
  assert.deepEqual(event, {timestamp: Date.parse('2025-04-05T12:30:00Z'), precision: 'minute'});
});
