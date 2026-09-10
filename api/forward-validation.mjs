import crypto from 'node:crypto';
import {calculateForwardMetrics} from '../src/forward-validation/metrics.mjs';

function sameToken(supplied, expected) {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authorizeForwardRequest(request, expected = process.env.TELEEDGE_REVIEWS_TOKEN || '') {
  return sameToken(request.headers.get('x-teleeg-reviews-token') || '', expected);
}

async function supabaseRequest(pathname, options = {}) {
  const base = process.env.SUPABASE_URL || 'https://jfvbikivtpfjgfsnggiz.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!key) throw new Error('forward-validation service key unavailable');
  const result = await fetch(`${base}/rest/v1/${pathname}`, {
    ...options,
    headers: {apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(options.headers || {})},
    signal: AbortSignal.timeout(8000),
  });
  const text = await result.text();
  if (!result.ok) throw new Error(`Supabase ${result.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') return response.status(405).json({ok: false, error: 'method-not-allowed'});
  if (!authorizeForwardRequest(request)) return response.status(401).json({ok: false, error: 'unauthorized'});
  try {
    if (request.method === 'POST') {
      const body = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body || {});
      if (body.action !== 'manual-decision') return response.status(400).json({ok: false, error: 'unsupported-forward-action'});
      const row = {...body, decision_id: body.decision_id || `manual-${body.signal_id}`, updated_at: new Date().toISOString()};
      delete row.action;
      const inserted = await supabaseRequest('forward_manual_decisions?on_conflict=decision_id', {method: 'POST', headers: {prefer: 'resolution=merge-duplicates,return=representation'}, body: JSON.stringify(row)});
      return response.status(200).json({ok: true, manualDecision: inserted[0] || null});
    }
    const runs = await supabaseRequest('forward_validation_runs?select=*&order=prepared_at.desc&limit=1');
    const run = runs[0] || null;
    if (!run) return response.status(200).json({ok: true, run: null, signals: [], outcomes: [], manualDecisions: []});
    const [signals, outcomes] = await Promise.all([
      supabaseRequest(`forward_validation_signals?run_id=eq.${encodeURIComponent(run.run_id)}&select=*`),
      supabaseRequest(`forward_validation_outcomes?run_id=eq.${encodeURIComponent(run.run_id)}&select=*`),
    ]);
    return response.status(200).json({ok: true, run, signals, outcomes, metrics: calculateForwardMetrics(signals, outcomes)});
  } catch (error) {
    return response.status(502).json({ok: false, error: String(error)});
  }
}
