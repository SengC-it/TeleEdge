function latestByEvent(outbox, signalId, eventType) {
  return (outbox || [])
    .filter(item => item.position_signal_id === signalId && item.event_type === eventType)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}

export function notificationFor(outbox, signalId, eventType) {
  const item = latestByEvent(outbox, signalId, eventType);
  return {
    status: item?.status || 'not-created',
    attempts: Number(item?.attempts || 0),
    error: item?.last_error || null,
    sentAt: item?.sent_at || null,
  };
}

export function buildReviewsPayload(positions, outbox = []) {
  const trades = [...(positions || [])]
    .map(position => ({
      ...position,
      notificationStatus: {
        entry: notificationFor(outbox, position.signal_id || position.id, 'entry'),
        exit: notificationFor(outbox, position.signal_id || position.id, 'exit'),
      },
    }))
    .sort((a, b) => String(b.signal_time || b.signalTime || '').localeCompare(String(a.signal_time || a.signalTime || '')));
  const closed = trades.filter(position => position.status === 'closed');
  return {
    ok: true,
    source: 'teleeg_positions',
    closedSignals: closed.length,
    wins: closed.filter(position => position.exit_reason === 'tp' || position.exitReason === 'tp').length,
    losses: closed.filter(position => position.exit_reason === 'sl' || position.exitReason === 'sl').length,
    trades,
  };
}
