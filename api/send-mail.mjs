import nodemailer from 'nodemailer';

const WORKER_URL = 'https://jfvbikivtpfjgfsnggiz.supabase.co/functions/v1/teleeg-worker';

async function verifyWorkerToken(token) {
  if (!token) return false;
  const result = await fetch(WORKER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-teleeg-token': token,
    },
    body: JSON.stringify({action: 'verify'}),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await result.json().catch(() => ({}));
  return result.status === 400 && payload.error === 'unknown-action';
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ok: false, error: 'method-not-allowed'});
  const workerToken = request.headers['x-teleeg-token'];
  if (!await verifyWorkerToken(Array.isArray(workerToken) ? workerToken[0] : workerToken)) {
    return response.status(401).json({ok: false, error: 'unauthorized'});
  }

  const user = process.env.GMAIL_USER;
  const to = process.env.TELEEDGE_EMAIL_TO || user;
  const password = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !to || !password) {
    return response.status(503).json({ok: false, error: 'Gmail SMTP environment variables are incomplete'});
  }

  const subject = String(request.body?.subject || '').slice(0, 300);
  const message = String(request.body?.message || '').slice(0, 100_000);
  if (!subject || !message) return response.status(400).json({ok: false, error: 'subject-and-message-required'});

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {user, pass: password},
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const result = await transporter.sendMail({
      from: {name: 'TeleEdge', address: user},
      to,
      subject,
      text: message,
    });
    return response.status(200).json({ok: true, messageId: result.messageId});
  } catch (error) {
    console.error('TeleEdge Gmail SMTP failure', error);
    return response.status(502).json({ok: false, error: String(error)});
  }
}
