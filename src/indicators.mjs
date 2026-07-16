export function aggregate(rows, period, end = Infinity) {
  const output = [];
  for (const row of rows) {
    const t = Math.floor(row.t / period) * period;
    let bar = output.at(-1);
    if (!bar || bar.t !== t) {
      bar = {t, o: row.o, h: row.h, l: row.l, c: row.c, q: row.q || 0};
      output.push(bar);
    } else {
      bar.h = Math.max(bar.h, row.h);
      bar.l = Math.min(bar.l, row.l);
      bar.c = row.c;
      bar.q += row.q || 0;
    }
  }
  return output.filter(bar => bar.t + period <= end);
}

export function ema(rows, period) {
  const output = new Array(rows.length).fill(null);
  const alpha = 2 / (period + 1);
  let value = rows[0]?.c;
  for (let i = 0; i < rows.length; i++) {
    value = i ? rows[i].c * alpha + value * (1 - alpha) : value;
    if (i >= period - 1) output[i] = value;
  }
  return output;
}

export function atr(rows, period = 14) {
  const output = new Array(rows.length).fill(null);
  let value = 0;
  for (let i = 0; i < rows.length; i++) {
    const tr = i
      ? Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c))
      : rows[i].h - rows[i].l;
    if (i < period) {
      value += tr;
      if (i === period - 1) {
        value /= period;
        output[i] = value;
      }
    } else {
      value = (value * (period - 1) + tr) / period;
      output[i] = value;
    }
  }
  return output;
}

export function rsi(rows, period = 14) {
  const output = new Array(rows.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].c - rows[i - 1].c;
    const up = Math.max(delta, 0);
    const down = Math.max(-delta, 0);
    if (i <= period) {
      gain += up;
      loss += down;
      if (i === period) {
        gain /= period;
        loss /= period;
        output[i] = 100 - 100 / (1 + gain / (loss || 1e-12));
      }
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + down) / period;
      output[i] = 100 - 100 / (1 + gain / (loss || 1e-12));
    }
  }
  return output;
}

export function adx(rows, period = 14) {
  const n = rows.length;
  const tr = new Array(n).fill(0);
  const plus = new Array(n).fill(0);
  const minus = new Array(n).fill(0);
  const dx = new Array(n).fill(null);
  const output = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c));
    const up = rows[i].h - rows[i - 1].h;
    const down = rows[i - 1].l - rows[i].l;
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
  }
  let smoothedTr = 0;
  let smoothedPlus = 0;
  let smoothedMinus = 0;
  for (let i = 1; i < n; i++) {
    if (i <= period) {
      smoothedTr += tr[i];
      smoothedPlus += plus[i];
      smoothedMinus += minus[i];
    } else {
      smoothedTr = smoothedTr - smoothedTr / period + tr[i];
      smoothedPlus = smoothedPlus - smoothedPlus / period + plus[i];
      smoothedMinus = smoothedMinus - smoothedMinus / period + minus[i];
    }
    if (i >= period) {
      const positive = 100 * smoothedPlus / (smoothedTr || 1);
      const negative = 100 * smoothedMinus / (smoothedTr || 1);
      dx[i] = 100 * Math.abs(positive - negative) / (positive + negative || 1);
    }
    if (i === 2 * period - 1) {
      let total = 0;
      for (let j = period; j <= i; j++) total += dx[j] || 0;
      output[i] = total / period;
    } else if (i >= 2 * period) {
      output[i] = (output[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return output;
}

export function lowerBound(values, target, accessor = value => value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (accessor(values[middle]) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}
