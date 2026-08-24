# TeleEdge mail delivery

The worker calls the Vercel SMTP gateway server-to-server. Vercel Deployment Protection runs before `api/send-mail.mjs`, so the worker must send the project automation bypass header when protection is enabled.

Configure this without committing a secret:

1. In the `teleedge` Vercel project, open **Settings → Deployment Protection → Protection Bypass for Automation** and create a dedicated secret for `teleeg-worker`.
2. In Supabase Edge Function secrets, set `VERCEL_AUTOMATION_BYPASS_SECRET` to that value. Optionally set `TELEEDGE_MAIL_ENDPOINT` to the intended Vercel deployment URL; otherwise the production URL is used.
3. Keep `GMAIL_USER`, `TELEEDGE_EMAIL_TO`, and `GMAIL_APP_PASSWORD` only in Vercel production environment variables.
4. Redeploy the Vercel project after rotating the bypass secret. Revoke the old secret after the new deployment is ready.
5. Invoke the worker `mail` action and check `teleeg_job_runs.summary` plus `teleeg_outbox.last_error`. A failed delivery may change only the outbox row; it must never change `teleeg_positions` or account settlement state.

The request header is `x-vercel-protection-bypass`, populated only from the Edge Function environment. `x-vercel-set-bypass-cookie` is intentionally not used because this is a direct server-to-server request and does not need a browser cookie.
