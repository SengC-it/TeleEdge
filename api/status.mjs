export default async function handler(_request, response) {
  // The publishable key is intentionally public and can only read the single
  // RLS-protected teleeg_public_status row. No service key reaches Vercel.
  const url = process.env.SUPABASE_URL || 'https://jfvbikivtpfjgfsnggiz.supabase.co';
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_fZGGAmBooR_bOSkrILTvPA_13ddJuUD';
  try {
    const result = await fetch(`${url}/rest/v1/teleeg_public_status?select=*&id=eq.1`, {
      headers: {apikey: key, authorization: `Bearer ${key}`},
      signal: AbortSignal.timeout(8000),
    });
    const text = await result.text();
    if (!result.ok) throw new Error(`Supabase ${result.status}: ${text.slice(0, 200)}`);
    const status = JSON.parse(text)[0] ?? null;
    response.setHeader('cache-control', 'no-store');
    return response.status(status ? 200 : 503).json({ok: Boolean(status), status});
  } catch (error) {
    return response.status(502).json({ok: false, error: String(error)});
  }
}
