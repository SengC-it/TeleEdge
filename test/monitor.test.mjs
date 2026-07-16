import test from 'node:test';
import assert from 'node:assert/strict';
import {firstTouch} from '../src/service.mjs';

test('stop wins when TP and SL occur in the same minute', () => {
  const position = {side: 'long', stop: 95, target: 110};
  const touch = firstTouch(position, [{t: 1_000_000, h: 111, l: 94}]);
  assert.equal(touch.reason, 'sl');
  assert.equal(touch.ambiguous, true);
});

test('position remains open without a TP or SL touch', () => {
  const position = {side: 'short', stop: 105, target: 90};
  assert.equal(firstTouch(position, [
    {t: 1_000_000, h: 103, l: 98},
    {t: 1_060_000, h: 102, l: 96},
  ]), null);
});

test('first chronological touch settles the position', () => {
  const position = {side: 'short', stop: 105, target: 90};
  const touch = firstTouch(position, [
    {t: 1_000_000, h: 103, l: 89},
    {t: 1_060_000, h: 106, l: 95},
  ]);
  assert.equal(touch.reason, 'tp');
  assert.equal(touch.price, 90);
});
