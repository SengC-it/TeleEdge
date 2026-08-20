function latestByEvent(outbox, signalId, eventType) {
  return (outbox || [])
    .filter(item => item.position_signal_id === signalId && item.event_type === eventType)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}

function notificationFor(outbox, signalId, eventType) {
  const item = latestByEvent(outbox, signalId, eventType);
  return {
    status: item?.status || 'not-created',
    attempts: Number(item?.attempts || 0),
    error: item?.last_error || null,
    sentAt: item?.sent_at || null,
  };
}

// The reviews endpoint is intentionally authenticated with an independent
// server-to-server secret. Hashing both values before comparing keeps the
// comparison independent of the secret length and avoids a plain-text token
// comparison in the request path.
export async function authorizeReviewsRequest(request, expectedToken) {
  const supplied = request.headers.get('x-teleeg-reviews-token') ?? '';
  if (!expectedToken || !supplied || supplied.length !== expectedToken.length) return false;
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expectedToken)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(supplied)),
  ]);
  let mismatch = 0;
  for (let index = 0; index < expectedHash.byteLength; index++) {
    mismatch |= new Uint8Array(expectedHash)[index] ^ new Uint8Array(suppliedHash)[index];
  }
  return mismatch === 0;
}

export function buildReviewsPayload(positions, outbox = []) {
  const trades = [...(positions || [])]
    .map(position => ({
      ...position,
      notificationStatus: {
        entry: notificationFor(outbox, position.signal_id, 'entry'),
        exit: notificationFor(outbox, position.signal_id, 'exit'),
      },
    }))
    .sort((a, b) => String(b.signal_time || '').localeCompare(String(a.signal_time || '')));
  const closed = trades.filter(position => position.status === 'closed');
  return {
    ok: true,
    source: 'teleeg_positions',
    closedSignals: closed.length,
    wins: closed.filter(position => position.exit_reason === 'tp').length,
    losses: closed.filter(position => position.exit_reason === 'sl').length,
    trades,
  };
}
