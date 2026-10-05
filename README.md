# OmniCal

**Open-source omnichannel AI calorie tracker** — log meals by photo, voice or text, get calories/macros, goal coaching and stall detection. One Cloudflare Worker brain, six channels.

A multi-channel take on *Mochi* (AI calorie tracker via iMessage, listed for sale at $999 on r/saasforsale): the original lived in **one** inbox. OmniCal lives in **all of them**:

| Channel | How it plugs in | Setup |
|---|---|---|
| 🌐 Web Chat | Built-in chat UI (`/api/chat`) | Zero — works on deploy |
| ✈️ Telegram | Bot webhook (`/webhook/telegram`) | BotFather token |
| 💬 WhatsApp | Meta Cloud API (`/webhook/whatsapp`) | WhatsApp Business + token |
| 📘 Messenger | Meta webhook (`/webhook/messenger`) | Page token |
| 📱 SMS | Twilio webhook (`/webhook/sms`, TwiML reply) | Twilio number |
| 🍏 iMessage | Bridge webhook (`/webhook/imessage`) | Sendblue / Loop / BlueBubbles style provider* |

\* Apple offers no official iMessage bot API; bridges forward messages in/out. OmniCal accepts their common JSON shape and returns the reply for the bridge to send.

## What it does

- 📸 **Photo logging** — meal photo → Workers AI Vision (Llama 3.2 Vision) estimates items, kcal, protein/carbs/fat
- 🎙️ **Voice logging** — voice note → Whisper transcription → same parsing pipeline
- ✍️ **Text logging** — "2 eggs, toast and a latte" → AI parse (Llama 3.3 70B), with a deterministic nutrition-DB fallback so it never hard-fails
- 🎯 **Goals** — `goal lose 1800` sets goal + daily target; every log replies with today's remaining kcal
- ⚖️ **Weight + stall detection** — `weight 72.5` logs weight; 7+ days flat (±0.3 kg) with good adherence triggers an adjustment suggestion (−100 kcal/day)
- 📊 **Dashboard** — today's progress bar, macro totals, recent meals across all channels (same user per channel identity)

## Architecture (Cloudflare-native)

```
Telegram ─┐
WhatsApp ─┤
Messenger ┼─► webhook adapters ─► processInbound() ─► Workers AI (Vision/Whisper/LLM)
SMS ──────┤        (one core)            │                     │
iMessage ─┤                              ▼                     ▼
Web Chat ─┘                        D1 (users/meals/        fallback nutrition DB
                                   weights/messages)       (deterministic)
                                   R2 (meal photos)
```

Channel identity is `(channel, channel_user_id)` — the same brain, separate inboxes; the core never knows which channel a message came from beyond the reply transport.

## Quick start

```bash
git clone https://github.com/tuannx/omnical.git
cd omnical
npm install
npm run db:create        # paste the D1 id into wrangler.toml
npm run db:migrate:local
npm run dev              # http://localhost:8787 — web channel works immediately
npm run db:migrate && npm run deploy
```

Try it in the web chat: `goal lose 1800` → `2 eggs, toast and a latte` → `weight 72.5` → `today`.

## Channel setup

- **Telegram**: create a bot with BotFather, `npx wrangler secret put TELEGRAM_BOT_TOKEN`, then set webhook: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-worker>/webhook/telegram`
- **WhatsApp / Messenger**: create a Meta app, set `META_VERIFY_TOKEN` + channel tokens as secrets, point webhooks to `/webhook/whatsapp` / `/webhook/messenger`
- **SMS**: in Twilio, set the number's messaging webhook to `POST https://<your-worker>/webhook/sms`
- **iMessage bridge**: configure your bridge to POST `{from, text, mediaBase64?}` to `/webhook/imessage` and send back the returned `reply`

All secrets go through `wrangler secret put` — never commit them.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health + channel list |
| POST | `/api/chat` | Web channel: `{userKey, message}` or `{userKey, imageBase64}` |
| GET | `/api/dashboard?userKey=` | Today totals, recent meals, weights |
| POST | `/webhook/telegram` `/whatsapp` `/messenger` `/sms` `/imessage` | Channel webhooks |

In-chat commands (every channel): `goal lose|maintain|gain [kcal]`, `weight <kg>`, `today`, `help`.

## Tests

```bash
npm test   # fallback parser totals, food disambiguation, stall detection
```

## Compared to the original listing

| | Mochi (for sale, $999) | OmniCal (this repo) |
|---|---|---|
| Channels | iMessage only | Web, Telegram, WhatsApp, Messenger, SMS, iMessage bridge |
| Logging | Photo/voice/text | Photo/voice/text (same) |
| Stall detection | Claimed | Rule-based, tested |
| Metrics disclosed | None (asked in comments) | Your own D1 — every number queryable |
| Stack | Not stated | Workers + D1 + R2 + Workers AI, MIT |

## Roadmap

- [ ] Cross-channel identity linking (same person on Telegram + WhatsApp)
- [ ] Daily/weekly summary nudges via Queues + Cron Triggers
- [ ] Barcode / restaurant menu lookup
- [ ] Weight trend chart + adaptive targets (TDEE learning)

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with Mochi; built as an open-source, self-hostable alternative.
