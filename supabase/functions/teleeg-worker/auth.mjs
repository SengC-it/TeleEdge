export async function sha256Token(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function authorizeWorkerToken(suppliedToken, expectedHash) {
  if (typeof suppliedToken !== 'string' || suppliedToken.length === 0) return false;
  if (typeof expectedHash !== 'string' || expectedHash.length !== 64) return false;
  return await sha256Token(suppliedToken) === expectedHash.toLowerCase();
}
