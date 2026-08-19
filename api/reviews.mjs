const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jfvbikivtpfjgfsnggiz.supabase.co';
const REVIEWS_URL = process.env.TELEEDGE_REVIEWS_URL || `${SUPABASE_URL}/functions/v1/teleeg-reviews`;

export default async function handler(_request, response) {
  try {
    const result = await fetch(REVIEWS_URL, {
      headers: {'accept': 'application/json'},
      signal: AbortSignal.timeout(8000),
    });
    const text = await result.text();
    if (!result.ok) throw new Error(`Reviews service ${result.status}: ${text.slice(0, 300)}`);
    const payload = JSON.parse(text);
    response.setHeader('cache-control', 'no-store');
    return response.status(200).json(payload);
  } catch (error) {
    console.error('TeleEdge reviews failure', error);
    return response.status(502).json({ok: false, error: String(error)});
  }
}
