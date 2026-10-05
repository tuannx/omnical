# Deploy checklist (one-time)

Deploy is blocked on exactly one thing: Cloudflare authentication. (`wrangler login`
OAuth does not work from every environment; an API token is the reliable route.)

## Option A — GitHub Actions (recommended, token never touches a dev machine again)

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → template
   **"Edit Cloudflare Workers"** (includes Workers Scripts, D1, R2 edit). Copy it once.
2. Enable Workers AI once (dashboard → AI → Workers AI) for full-quality photo/voice.
3. In this GitHub repo → Settings → Secrets and variables → Actions, add:
   - `CLOUDFLARE_API_TOKEN` (the token from step 1)
   - `CLOUDFLARE_ACCOUNT_ID` (dashboard → Workers & Pages → right sidebar)
4. Actions tab → "Deploy to Cloudflare" → Run workflow. The workflow creates the
   D1 database and R2 bucket if missing, fills in the database_id, applies
   migrations remotely, then deploys. Future deploys = re-run the workflow.
   Channel webhooks (Telegram/WhatsApp/…) are pointed at the deployed Worker URL
   afterwards — see the channel table in README.md.

## Option B — local wrangler (one-time token, transient)

```bash
export CLOUDFLARE_API_TOKEN=<token>   # this shell only, never commit
npm run db:create                     # paste the D1 id into wrangler.toml
npx wrangler r2 bucket create omnical-photos
npm run db:migrate
npm run deploy
```

The web channel works the moment it deploys (fallback nutrition DB). Photo/voice
quality uses Workers AI once enabled on the account.
