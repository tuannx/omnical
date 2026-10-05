// Deterministic fallback nutrition DB (per typical portion) — used when Workers AI is unavailable,
// and as a sanity anchor for AI estimates. Values are approximate public-domain nutrition facts.
export const FOODS: Record<string, { kcal: number; protein: number; carbs: number; fat: number; label: string }> = {
  egg: { kcal: 78, protein: 6, carbs: 0.6, fat: 5, label: 'egg' },
  eggs: { kcal: 78, protein: 6, carbs: 0.6, fat: 5, label: 'egg' },
  rice: { kcal: 260, protein: 5, carbs: 57, fat: 0.6, label: 'cooked rice (1 cup)' },
  'chicken breast': { kcal: 165, protein: 31, carbs: 0, fat: 3.6, label: 'chicken breast (100g)' },
  chicken: { kcal: 165, protein: 31, carbs: 0, fat: 3.6, label: 'chicken (100g)' },
  beef: { kcal: 250, protein: 26, carbs: 0, fat: 15, label: 'beef (100g)' },
  salmon: { kcal: 208, protein: 20, carbs: 0, fat: 13, label: 'salmon (100g)' },
  tuna: { kcal: 132, protein: 28, carbs: 0, fat: 1, label: 'tuna (100g)' },
  toast: { kcal: 90, protein: 3, carbs: 17, fat: 1, label: 'toast (1 slice)' },
  bread: { kcal: 90, protein: 3, carbs: 17, fat: 1, label: 'bread (1 slice)' },
  avocado: { kcal: 160, protein: 2, carbs: 9, fat: 15, label: 'avocado (1/2)' },
  banana: { kcal: 105, protein: 1.3, carbs: 27, fat: 0.4, label: 'banana' },
  apple: { kcal: 95, protein: 0.5, carbs: 25, fat: 0.3, label: 'apple' },
  yogurt: { kcal: 150, protein: 12, carbs: 15, fat: 4, label: 'Greek yogurt (170g)' },
  milk: { kcal: 150, protein: 8, carbs: 12, fat: 8, label: 'milk (1 cup)' },
  cheese: { kcal: 113, protein: 7, carbs: 0.4, fat: 9, label: 'cheese (1 oz)' },
  pasta: { kcal: 320, protein: 11, carbs: 62, fat: 2, label: 'cooked pasta (1.5 cup)' },
  noodle: { kcal: 300, protein: 9, carbs: 55, fat: 4, label: 'noodles (1 bowl)' },
  pho: { kcal: 450, protein: 25, carbs: 60, fat: 10, label: 'pho (1 bowl)' },
  salad: { kcal: 150, protein: 4, carbs: 12, fat: 9, label: 'salad bowl' },
  burger: { kcal: 550, protein: 25, carbs: 40, fat: 30, label: 'burger' },
  pizza: { kcal: 285, protein: 12, carbs: 36, fat: 10, label: 'pizza (1 slice)' },
  fries: { kcal: 365, protein: 4, carbs: 48, fat: 17, label: 'fries (medium)' },
  coffee: { kcal: 5, protein: 0, carbs: 0, fat: 0, label: 'black coffee' },
  latte: { kcal: 150, protein: 7, carbs: 12, fat: 7, label: 'latte' },
  soda: { kcal: 140, protein: 0, carbs: 39, fat: 0, label: 'soda (1 can)' },
  beer: { kcal: 150, protein: 1, carbs: 13, fat: 0, label: 'beer (1 can)' },
  proteinshake: { kcal: 160, protein: 25, carbs: 6, fat: 3, label: 'protein shake' },
  oatmeal: { kcal: 300, protein: 10, carbs: 54, fat: 5, label: 'oatmeal (1 bowl)' },
  sandwich: { kcal: 400, protein: 18, carbs: 40, fat: 18, label: 'sandwich' },
  sushi: { kcal: 300, protein: 12, carbs: 45, fat: 7, label: 'sushi roll' },
}

export type FoodItem = { name: string; qty: number; kcal: number; protein: number; carbs: number; fat: number }

export function fallbackParse(text: string): { items: FoodItem[]; kcal: number; protein: number; carbs: number; fat: number } {
  const lower = ' ' + text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ') + ' '
  const items: FoodItem[] = []
  const seen = new Set<string>()
  // longest keys first so "chicken breast" wins over "chicken"
  for (const key of Object.keys(FOODS).sort((a, b) => b.length - a.length)) {
    if (!lower.includes(key)) continue
    if (seen.has(FOODS[key].label)) continue
    if (key === 'chicken' && items.some(i => i.name.includes('chicken breast'))) continue
    const f = FOODS[key]
    // quantity: number right before the food word, default 1
    const m = lower.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:x\\s*)?${key.replace(/ /g, '\\s+')}`))
    const qty = m ? parseFloat(m[1]) : 1
    items.push({ name: f.label, qty, kcal: Math.round(f.kcal * qty), protein: +(f.protein * qty).toFixed(1), carbs: +(f.carbs * qty).toFixed(1), fat: +(f.fat * qty).toFixed(1) })
    seen.add(f.label)
  }
  const totals = items.reduce((a, i) => ({ kcal: a.kcal + i.kcal, protein: +(a.protein + i.protein).toFixed(1), carbs: +(a.carbs + i.carbs).toFixed(1), fat: +(a.fat + i.fat).toFixed(1) }), { kcal: 0, protein: 0, carbs: 0, fat: 0 })
  return { items, ...totals }
}

// Stall detection: weight flat (±0.3kg) over the window while adherence is decent.
export function detectStall(weights: { weight_kg: number; created_at: number }[], adherence: number): { stalled: boolean; suggestion: string } {
  if (weights.length < 3) return { stalled: false, suggestion: '' }
  const sorted = [...weights].sort((a, b) => a.created_at - b.created_at)
  const first = sorted[0].weight_kg, last = sorted[sorted.length - 1].weight_kg
  const days = (sorted[sorted.length - 1].created_at - sorted[0].created_at) / 86400000
  if (days >= 7 && Math.abs(last - first) <= 0.3 && adherence >= 0.7) {
    return { stalled: true, suggestion: `Weight has been flat (${first}kg → ${last}kg over ${Math.round(days)} days) despite good logging. Suggest adjusting target by −100 kcal/day or adding a 20-min walk, then re-check in 7 days.` }
  }
  return { stalled: false, suggestion: '' }
}

export function todayKey(ts = Date.now(), tzOffsetMin = 0): string {
  const d = new Date(ts + tzOffsetMin * 60000)
  return d.toISOString().slice(0, 10)
}
