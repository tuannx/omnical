import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { fallbackParse, detectStall } from './nutrition'

type Bindings = {
  DB: D1Database
  AI: any
  PHOTOS?: R2Bucket
  ASSETS: Fetcher
  LLM_MODEL?: string
  VISION_MODEL?: string
  WHISPER_MODEL?: string
  TELEGRAM_BOT_TOKEN?: string
  WHATSAPP_TOKEN?: string
  WHATSAPP_PHONE_ID?: string
  META_VERIFY_TOKEN?: string
  MESSENGER_PAGE_TOKEN?: string
  TWILIO_FROM_NUMBER?: string
}

export type Channel = 'web' | 'telegram' | 'whatsapp' | 'messenger' | 'sms' | 'imessage'
export type Inbound = { channel: Channel; channelUserId: string; name?: string; type: 'text' | 'image' | 'audio'; text?: string; imageBase64?: string; audioBytes?: Uint8Array; photoKey?: string }

const app = new Hono<{ Bindings: Bindings }>()
app.use('/api/*', cors())
const uid = () => crypto.randomUUID()
const now = () => Date.now()

// ---------- core ----------
async function getOrCreateUser(env: Bindings, channel: Channel, channelUserId: string, name = '') {
  let u = await env.DB.prepare('SELECT * FROM users WHERE channel=? AND channel_user_id=?').bind(channel, channelUserId).first<any>()
  if (!u) {
    const id = uid()
    await env.DB.prepare('INSERT INTO users (id, channel, channel_user_id, name, created_at) VALUES (?,?,?,?,?)').bind(id, channel, channelUserId, name, now()).run()
    u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first<any>()
  }
  return u
}

async function logMsg(env: Bindings, userId: string | null, channel: string, direction: string, type: string, body: string) {
  try { await env.DB.prepare('INSERT INTO messages (id, user_id, channel, direction, type, body, created_at) VALUES (?,?,?,?,?,?,?)').bind(uid(), userId, channel, direction, type, body.slice(0, 4000), now()).run() } catch {}
}

async function todaySummary(env: Bindings, userId: string) {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const row = await env.DB.prepare('SELECT COALESCE(SUM(kcal),0) kcal, COALESCE(SUM(protein_g),0) protein, COALESCE(SUM(carbs_g),0) carbs, COALESCE(SUM(fat_g),0) fat, COUNT(*) meals FROM meals WHERE user_id=? AND created_at>=?').bind(userId, start.getTime()).first<any>()
  return { kcal: row?.kcal || 0, protein: +(row?.protein || 0).toFixed(1), carbs: +(row?.carbs || 0).toFixed(1), fat: +(row?.fat || 0).toFixed(1), meals: row?.meals || 0 }
}

const PARSE_PROMPT = (text: string) => `You are a nutrition logging assistant. Parse this meal description into JSON ONLY:
{"items":[{"name":"...","qty":1,"kcal":0,"protein":0,"carbs":0,"fat":0}],"kcal":0,"protein":0,"carbs":0,"fat":0,"reply":"short friendly confirmation with one coaching tip"}
Use realistic portion estimates. Description: "${text.replace(/"/g, "'")}"`

const VISION_PROMPT = `You are a nutrition assistant. Look at this meal photo. Estimate calories and macros. Return JSON ONLY:
{"items":[{"name":"...","qty":1,"kcal":0,"protein":0,"carbs":0,"fat":0}],"kcal":0,"protein":0,"carbs":0,"fat":0,"reply":"short description of what you see + estimate note"}`

function parseJson(raw: string): any {
  const c = raw.replace(/```json|```/g, '').trim(); const s = c.indexOf('{'), e = c.lastIndexOf('}')
  if (s === -1 || e === -1) throw new Error('no json')
  return JSON.parse(c.slice(s, e + 1))
}

async function aiParseText(env: Bindings, text: string) {
  try {
    const out: any = await env.AI.run(env.LLM_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'user', content: PARSE_PROMPT(text) }], max_tokens: 1024 })
    return parseJson(out?.response || '')
  } catch { return null }
}

async function aiParseImage(env: Bindings, imageBase64: string) {
  try {
    const bytes = Uint8Array.from(atob(imageBase64), ch => ch.charCodeAt(0))
    const out: any = await env.AI.run(env.VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct', { prompt: VISION_PROMPT, image: [...bytes] })
    return parseJson(out?.response || out?.description || '')
  } catch { return null }
}

async function aiTranscribe(env: Bindings, audio: Uint8Array): Promise<string> {
  const out: any = await env.AI.run(env.WHISPER_MODEL || '@cf/openai/whisper-large-v3-turbo', { audio: [...audio] })
  return out?.text || ''
}

// Commands: goal / weight / today / help — handled before AI so they work on every channel.
async function handleCommand(env: Bindings, user: any, text: string): Promise<string | null> {
  const t = text.trim(); const lower = t.toLowerCase()
  if (lower === 'help' || lower === '/help' || lower === '/start') return `Hi${user.name ? ' ' + user.name : ''}! I'm OmniCal 🍽️\n\nLog a meal by sending:\n• Text: "2 eggs, toast and a latte"\n• A meal photo 📸\n• A voice note 🎙️\n\nCommands:\n• "goal lose 1800" — set goal + daily kcal target\n• "weight 72.5" — log today's weight\n• "today" — today's totals\nGoal: ${user.goal_type || user.goal_type} · Target: ${user.target_kcal} kcal/day`
  if (lower === 'today') { const s = await todaySummary(env, user.id); const left = user.target_kcal - s.kcal; return `Today so far: ${s.kcal} / ${user.target_kcal} kcal (${s.meals} meals)\nProtein ${s.protein}g · Carbs ${s.carbs}g · Fat ${s.fat}g\n${left >= 0 ? `${left} kcal left today.` : `${Math.abs(left)} kcal over — no guilt, just data. Lighter next meal?`}` }
  const gm = lower.match(/^goal\s+(lose|maintain|gain)(?:\s+(\d{3,4}))?/)
  if (gm) { const kcal = gm[2] ? parseInt(gm[2]) : (gm[1] === 'lose' ? 1800 : gm[1] === 'gain' ? 2600 : 2100); await env.DB.prepare('UPDATE users SET goal_type=?, target_kcal=? WHERE id=?').bind(gm[1], kcal, user.id).run(); return `Goal set: ${gm[1]} at ${kcal} kcal/day. Send me your next meal — photo, voice or text.` }
  const wm = lower.match(/^weight\s+(\d+(?:\.\d+)?)/)
  if (wm) { const kg = parseFloat(wm[1]); await env.DB.prepare('INSERT INTO weights (id, user_id, weight_kg, created_at) VALUES (?,?,?,?)').bind(uid(), user.id, kg, now()).run(); await env.DB.prepare('UPDATE users SET current_weight_kg=? WHERE id=?').bind(kg, user.id).run(); const ws = await env.DB.prepare('SELECT weight_kg, created_at FROM weights WHERE user_id=? ORDER BY created_at ASC').bind(user.id).all<any>(); const totalMeals = await env.DB.prepare('SELECT COUNT(*) n FROM meals WHERE user_id=?').bind(user.id).first<any>(); const stall = detectStall(ws.results || [], Math.min(1, (totalMeals?.n || 0) / 10)); return `Weight logged: ${kg} kg.${stall.stalled ? '\n⚠️ Stall check: ' + stall.suggestion : ''}` }
  return null
}

export async function processInbound(env: Bindings, msg: Inbound): Promise<string> {
  const user = await getOrCreateUser(env, msg.channel, msg.channelUserId, msg.name || '')
  await logMsg(env, user.id, msg.channel, 'in', msg.type, msg.text || `[${msg.type}]`)

  let text = msg.text || ''
  if (msg.type === 'audio' && msg.audioBytes) {
    try { text = await aiTranscribe(env, msg.audioBytes) } catch { const r = 'I could not transcribe that voice note — try again or type the meal.'; await logMsg(env, user.id, msg.channel, 'out', 'text', r); return r }
    if (!text) { const r = 'Voice note came through empty — type the meal instead?'; await logMsg(env, user.id, msg.channel, 'out', 'text', r); return r }
  }

  if (msg.type === 'text' || msg.type === 'audio') {
    const cmd = await handleCommand(env, user, text)
    if (cmd) { await logMsg(env, user.id, msg.channel, 'out', 'text', cmd); return cmd }
  }

  let parsed: any = null
  if (msg.type === 'image' && msg.imageBase64) parsed = await aiParseImage(env, msg.imageBase64)
  else parsed = await aiParseText(env, text)
  if (!parsed || !parsed.items?.length) parsed = { ...fallbackParse(text), reply: '' }
  if (!parsed.items?.length) { const r = `I couldn't spot food in "${text.slice(0, 80)}". Try like: "1 bowl pho and a latte" — or send a photo.`; await logMsg(env, user.id, msg.channel, 'out', 'text', r); return r }

  const mid = uid()
  await env.DB.prepare('INSERT INTO meals (id, user_id, channel, raw_text, photo_key, kcal, protein_g, carbs_g, fat_g, items_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(mid, user.id, msg.channel, text, msg.photoKey || null, Math.round(parsed.kcal || 0), parsed.protein || 0, parsed.carbs || 0, parsed.fat || 0, JSON.stringify(parsed.items), now()).run()

  const s = await todaySummary(env, user.id)
  const itemLines = parsed.items.map((i: any) => `• ${i.name} ×${i.qty || 1} — ${i.kcal} kcal`).join('\n')
  const reply = `${parsed.reply ? parsed.reply + '\n\n' : ''}Logged ✅\n${itemLines}\nTotal: ${Math.round(parsed.kcal)} kcal (P ${parsed.protein}g · C ${parsed.carbs}g · F ${parsed.fat}g)\n\nToday: ${s.kcal}/${user.target_kcal} kcal · ${user.target_kcal - s.kcal >= 0 ? (user.target_kcal - s.kcal) + ' left' : Math.abs(user.target_kcal - s.kcal) + ' over'}`
  await logMsg(env, user.id, msg.channel, 'out', 'text', reply)
  return reply
}

// ---------- channel senders (best-effort; web/telegram work with zero extra setup beyond token) ----------
async function sendTelegram(env: Bindings, chatId: string, text: string) {
  if (!env.TELEGRAM_BOT_TOKEN) return
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) }).catch(() => {})
}
async function sendWhatsApp(env: Bindings, to: string, text: string) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) return
  await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WHATSAPP_TOKEN}` }, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }) }).catch(() => {})
}
async function sendMessenger(env: Bindings, psid: string, text: string) {
  if (!env.MESSENGER_PAGE_TOKEN) return
  await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${env.MESSENGER_PAGE_TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: psid }, message: { text } }) }).catch(() => {})
}

// ---------- HTTP API (web channel + dashboard) ----------
app.get('/api/health', (c) => c.json({ ok: true, service: 'omnical', channels: ['web', 'telegram', 'whatsapp', 'messenger', 'sms', 'imessage'] }))
app.post('/api/chat', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const userKey = String(b.userKey || 'demo-user')
  let photoKey: string | undefined
  if (b.imageBase64 && c.env.PHOTOS) { try { photoKey = `photos/${uid()}.jpg`; await c.env.PHOTOS.put(photoKey, Uint8Array.from(atob(b.imageBase64), ch => ch.charCodeAt(0))) } catch {} }
  const reply = await processInbound(c.env, { channel: 'web', channelUserId: userKey, name: b.name || '', type: b.imageBase64 ? 'image' : 'text', text: b.message || '', imageBase64: b.imageBase64, photoKey })
  const user = await getOrCreateUser(c.env, 'web', userKey)
  return c.json({ reply, today: await todaySummary(c.env, user.id), user: { goal_type: user.goal_type, target_kcal: user.target_kcal } })
})
app.get('/api/dashboard', async (c) => {
  const userKey = c.req.query('userKey') || 'demo-user'
  const user = await getOrCreateUser(c.env, 'web', userKey)
  const meals = await c.env.DB.prepare('SELECT * FROM meals WHERE user_id=? ORDER BY created_at DESC LIMIT 30').bind(user.id).all()
  const weights = await c.env.DB.prepare('SELECT * FROM weights WHERE user_id=? ORDER BY created_at DESC LIMIT 30').bind(user.id).all()
  return c.json({ user: { goal_type: user.goal_type, target_kcal: user.target_kcal, current_weight_kg: user.current_weight_kg }, today: await todaySummary(c.env, user.id), meals: meals.results, weights: weights.results })
})

// ---------- webhooks: one core, every channel ----------
app.get('/webhook/whatsapp', (c) => { const q = c.req.query(); if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === c.env.META_VERIFY_TOKEN) return c.text(q['hub.challenge'] || ''); return c.text('forbidden', 403) })
app.get('/webhook/messenger', (c) => { const q = c.req.query(); if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === c.env.META_VERIFY_TOKEN) return c.text(q['hub.challenge'] || ''); return c.text('forbidden', 403) })

app.post('/webhook/telegram', async (c) => {
  const u: any = await c.req.json().catch(() => null); const m = u?.message; if (!m) return c.json({ ok: true })
  const chatId = String(m.chat.id); const name = m.from?.first_name || ''
  let inbound: Inbound = { channel: 'telegram', channelUserId: chatId, name, type: 'text', text: m.text || m.caption || '' }
  if (m.photo?.length && c.env.TELEGRAM_BOT_TOKEN) {
    const fileId = m.photo[m.photo.length - 1].file_id
    const f = await (await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`)).json() as any
    const buf = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${c.env.TELEGRAM_BOT_TOKEN}/${f.result.file_path}`)).arrayBuffer())
    inbound = { channel: 'telegram', channelUserId: chatId, name, type: 'image', text: m.caption || '', imageBase64: btoa(String.fromCharCode(...buf)) }
  } else if (m.voice && c.env.TELEGRAM_BOT_TOKEN) {
    const f = await (await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${m.voice.file_id}`)).json() as any
    const buf = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${c.env.TELEGRAM_BOT_TOKEN}/${f.result.file_path}`)).arrayBuffer())
    inbound = { channel: 'telegram', channelUserId: chatId, name, type: 'audio', audioBytes: buf }
  }
  const reply = await processInbound(c.env, inbound); await sendTelegram(c.env, chatId, reply); return c.json({ ok: true })
})

app.post('/webhook/whatsapp', async (c) => {
  const b: any = await c.req.json().catch(() => null); const msg = b?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]; if (!msg) return c.json({ ok: true })
  const from = msg.from; let inbound: Inbound = { channel: 'whatsapp', channelUserId: from, type: 'text', text: msg.text?.body || '' }
  if (msg.type === 'image' && c.env.WHATSAPP_TOKEN) {
    const meta: any = await (await fetch(`https://graph.facebook.com/v21.0/${msg.image.id}`, { headers: { Authorization: `Bearer ${c.env.WHATSAPP_TOKEN}` } })).json()
    const buf = new Uint8Array(await (await fetch(meta.url, { headers: { Authorization: `Bearer ${c.env.WHATSAPP_TOKEN}` } })).arrayBuffer())
    inbound = { channel: 'whatsapp', channelUserId: from, type: 'image', text: msg.image?.caption || '', imageBase64: btoa(String.fromCharCode(...buf)) }
  }
  const reply = await processInbound(c.env, inbound); await sendWhatsApp(c.env, from, reply); return c.json({ ok: true })
})

app.post('/webhook/messenger', async (c) => {
  const b: any = await c.req.json().catch(() => null); const m = b?.entry?.[0]?.messaging?.[0]; if (!m?.message) return c.json({ ok: true })
  const reply = await processInbound(c.env, { channel: 'messenger', channelUserId: m.sender.id, type: 'text', text: m.message.text || '' })
  await sendMessenger(c.env, m.sender.id, reply); return c.json({ ok: true })
})

app.post('/webhook/sms', async (c) => {
  // Twilio-style form webhook. Reply via TwiML so no extra API call is needed.
  const form = await c.req.parseBody().catch(() => ({} as any))
  const from = String((form as any).From || 'unknown'); const body = String((form as any).Body || '')
  const reply = await processInbound(c.env, { channel: 'sms', channelUserId: from, type: 'text', text: body })
  return c.text(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Message></Response>`, 200, { 'Content-Type': 'text/xml' })
})

app.post('/webhook/imessage', async (c) => {
  // iMessage has no official bot API. This endpoint accepts the common bridge shape
  // (Sendblue / Loop Message / BlueBubbles style): { from, text, mediaBase64?, secret }
  const b: any = await c.req.json().catch(() => null); if (!b?.from) return c.json({ error: 'missing_from' }, 400)
  const reply = await processInbound(c.env, { channel: 'imessage', channelUserId: String(b.from), type: b.mediaBase64 ? 'image' : 'text', text: b.text || '', imageBase64: b.mediaBase64 })
  return c.json({ ok: true, reply, note: 'Forward `reply` back through your iMessage bridge provider.' })
})

export default app
