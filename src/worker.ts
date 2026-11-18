interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  AI: {
    run(model: string, input: { text: string[] }): Promise<unknown>
  }
}

type MatchCandidate = {
  id: string
  direction: 'incoming' | 'outgoing'
  date?: string
  text: string
  senderDomain?: string
}
type MatchProduct = {
  id: string
  name: string
  category?: string
  platform?: string
  purchaseDate?: string
  saleDate?: string
  status?: string
}

const aiRequestWindows = new Map<string, { startedAt: number; count: number }>()

function jsonResponse(value: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function isValidGtin(value: string): boolean {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(value)) return false
  const body = value.slice(0, -1)
  let sum = 0
  let weight = 3
  for (let index = body.length - 1; index >= 0; index--) {
    sum += Number(body[index]) * weight
    weight = weight === 3 ? 1 : 3
  }
  return (10 - (sum % 10)) % 10 === Number(value.at(-1))
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : ''
}

function tokenize(value: string): Set<string> {
  const ignored = new Set([
    'the', 'and', 'mit', 'von', 'der', 'die', 'das', 'fur', 'fuer', 'und',
    'order', 'your', 'have', 'has', 'been', 'shipped', 'shipping', 'track',
    'tracking', 'number', 'package', 'parcel', 'shipment', 'delivery', 'sent',
    'versand', 'bestellung', 'sendung', 'paket', 'wurden', 'wurde', 'ist',
    'eine', 'einer', 'eines', 'bei', 'aus', 'for', 'with', 'this', 'box',
    'edition', 'limited', 'trainer', 'elite', 'collection', 'official',
    'universal', 'music', 'records', 'shop', 'store',
  ])
  return new Set(value.toLocaleLowerCase('de-DE')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(token => (token.length >= 3 || /^\d{4,}$/.test(token)) && !ignored.has(token)))
}

function lexicalSimilarity(emailText: string, productText: string): number {
  const emailTokens = tokenize(emailText)
  const productTokens = tokenize(productText)
  if (!emailTokens.size || !productTokens.size) return 0
  let matches = 0
  for (const token of productTokens) if (emailTokens.has(token)) matches++
  return matches / productTokens.size
}

function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length)
  if (!size) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < size; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (!leftNorm || !rightNorm) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

function vectorsFromResult(rawValue: unknown, expectedCount: number): number[][] {
  if (!rawValue || typeof rawValue !== 'object') return []
  const raw = rawValue as { data?: unknown; embeddings?: unknown; shape?: number[] }
  let values: unknown = raw.data ?? raw.embeddings
  if (!Array.isArray(values)) return []
  if (values.length && typeof values[0] === 'number') {
    const dimensions = Number(raw.shape?.[1] || 0)
    if (!dimensions || values.length !== expectedCount * dimensions) return []
    const flat = values as number[]
    return Array.from({ length: expectedCount }, (_, index) => flat.slice(index * dimensions, (index + 1) * dimensions))
  }
  const rows = values as unknown[]
  if (rows.length !== expectedCount) return []
  return rows.map(row => Array.isArray(row) ? row.map(Number) : [])
    .filter(row => row.length > 0 && row.every(Number.isFinite))
}

function dateBonus(candidate: MatchCandidate, product: MatchProduct): number {
  const messageTime = Date.parse(candidate.date || '')
  const purchaseTime = Date.parse(product.purchaseDate || '')
  const saleTime = Date.parse(product.saleDate || '')
  const referenceTime = candidate.direction === 'outgoing' ? saleTime : purchaseTime
  if (!Number.isFinite(messageTime) || !Number.isFinite(referenceTime)) return 0
  const days = (messageTime - referenceTime) / 86400000
  if (candidate.direction === 'incoming') {
    if (days >= -2 && days <= 75) return 0.045
    if (days < -30 || days > 180) return -0.025
  } else {
    if (days >= -2 && days <= 45) return 0.055
    if (days < -30 || days > 120) return -0.025
  }
  return 0
}

async function allowAiRequest(token: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  const now = Date.now()
  const current = aiRequestWindows.get(key)
  if (!current || now - current.startedAt > 60 * 60 * 1000) {
    aiRequestWindows.set(key, { startedAt: now, count: 1 })
    if (aiRequestWindows.size > 500) {
      for (const [storedKey, value] of aiRequestWindows) {
        if (now - value.startedAt > 60 * 60 * 1000) aiRequestWindows.delete(storedKey)
      }
    }
    return true
  }
  if (current.count >= 20) return false
  current.count++
  return true
}

async function matchShippingProducts(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get('Authorization') || ''
  const token = authorization.replace(/^Bearer\s+/i, '').trim()
  if (token.length < 20 || token.length > 10000) {
    return jsonResponse({ error: 'Gmail muss verbunden sein, bevor die KI-Zuordnung genutzt werden kann.' }, 401)
  }

  // Validate the short-lived token against the Gmail API. It is never stored.
  const verification = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  })
  if (!verification.ok) return jsonResponse({ error: 'Die Gmail-Berechtigung ist abgelaufen. Bitte verbinde Gmail erneut.' }, 401)
  if (!(await allowAiRequest(token))) return jsonResponse({ error: 'Zu viele KI-Abgleiche in kurzer Zeit. Bitte versuche es später erneut.' }, 429)

  const contentLength = Number(request.headers.get('Content-Length') || 0)
  if (contentLength > 140000) return jsonResponse({ error: 'Die KI-Anfrage ist zu groß. Bitte reduziere die Anzahl der Treffer.' }, 413)
  let body: { candidates?: MatchCandidate[]; products?: MatchProduct[] }
  try {
    body = await request.json() as typeof body
  } catch {
    return jsonResponse({ error: 'Die KI-Anfrage enthält kein gültiges JSON.' }, 400)
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : []
  const products = Array.isArray(body.products) ? body.products : []
  if (!candidates.length || candidates.length > 20 || !products.length || products.length > 70) {
    return jsonResponse({ error: 'Der KI-Abgleich unterstützt 1–20 E-Mails und 1–70 Produkte pro Durchlauf.' }, 400)
  }

  const cleanCandidates: MatchCandidate[] = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || !['incoming', 'outgoing'].includes(candidate.direction)) {
      return jsonResponse({ error: 'Eine E-Mail enthält ungültige Zuordnungsdaten.' }, 400)
    }
    const text = safeText(candidate.text, 1400)
    if (text.length < 8) return jsonResponse({ error: 'Eine E-Mail enthält zu wenig Text für einen KI-Abgleich.' }, 400)
    cleanCandidates.push({
      id: candidate.id.slice(0, 180),
      direction: candidate.direction,
      date: safeText(candidate.date, 40),
      text,
      senderDomain: safeText(candidate.senderDomain, 100),
    })
  }

  const cleanProducts: MatchProduct[] = []
  for (const product of products) {
    if (!product || typeof product.id !== 'string' || typeof product.name !== 'string' || !product.id.trim() || !product.name.trim()) {
      return jsonResponse({ error: 'Ein Produkt enthält ungültige Zuordnungsdaten.' }, 400)
    }
    cleanProducts.push({
      id: product.id.slice(0, 180),
      name: safeText(product.name, 180),
      category: safeText(product.category, 60),
      platform: safeText(product.platform, 100),
      purchaseDate: safeText(product.purchaseDate, 40),
      saleDate: safeText(product.saleDate, 40),
      status: safeText(product.status, 30),
    })
  }

  const emailTexts = cleanCandidates.map(candidate =>
    'Versand-E-Mail. Betreff und Nachricht: ' + candidate.text + '. Absender-Domain: ' + candidate.senderDomain +
    '. Richtung: ' + (candidate.direction === 'incoming' ? 'Einkauf, Paket zum Nutzer' : 'Verkauf, Paket vom Nutzer')
  )
  const productTexts = cleanProducts.map(product =>
    'Produkt: ' + product.name + '. Kategorie: ' + product.category + '. Verkaufsplattform oder Shop: ' + product.platform
  )
  let vectors: number[][]
  try {
    const raw = await env.AI.run('@cf/baai/bge-m3', { text: [...emailTexts, ...productTexts] })
    vectors = vectorsFromResult(raw, emailTexts.length + productTexts.length)
  } catch {
    return jsonResponse({ error: 'Das KI-Modell ist gerade nicht erreichbar. Die normale Gmail-Erkennung bleibt verfügbar.' }, 503)
  }
  if (vectors.length !== emailTexts.length + productTexts.length) {
    return jsonResponse({ error: 'Das KI-Modell hat ein unerwartetes Ergebnis geliefert. Bitte versuche es erneut.' }, 502)
  }

  const matches = cleanCandidates.map((candidate, candidateIndex) => {
    const emailVector = vectors[candidateIndex]
    const ranked = cleanProducts.map((product, productIndex) => {
      const semanticScore = cosineSimilarity(emailVector, vectors[emailTexts.length + productIndex])
      const lexicalScore = lexicalSimilarity(candidate.text, product.name)
      const score = Math.max(0, Math.min(1,
        semanticScore * 0.78 + lexicalScore * 0.22 + dateBonus(candidate, product)
      ))
      return { productId: product.id, score, semanticScore, lexicalScore }
    }).sort((left, right) => right.score - left.score)
    const best = ranked[0]
    const second = ranked[1]
    const hasClearLead = !second || best.score - second.score >= 0.055
    const hasEnoughEvidence = best.semanticScore >= 0.43 && (best.lexicalScore >= 0.12 || best.semanticScore >= 0.64)
    return {
      candidateId: candidate.id,
      productId: best.score >= 0.54 && hasClearLead && hasEnoughEvidence ? best.productId : '',
      score: Number(best.score.toFixed(4)),
      semanticScore: Number(best.semanticScore.toFixed(4)),
      lexicalScore: Number(best.lexicalScore.toFixed(4)),
    }
  })
  return jsonResponse({ model: '@cf/baai/bge-m3', matches })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    if (origin && origin !== url.origin) return jsonResponse({ error: 'Origin not allowed' }, 403)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
          'Access-Control-Allow-Origin': url.origin,
          'Vary': 'Origin',
        },
      })
    }

    if (url.pathname === '/api/shipping/match' && request.method === 'POST') {
      return matchShippingProducts(request, env)
    }

    if (url.pathname === '/api/product/lookup' && request.method === 'GET') {
      const barcodes = (url.searchParams.get('barcodes') || '').split(',').map(value => value.trim()).filter(Boolean)
      if (!barcodes.length || barcodes.length > 2 || barcodes.some(code => !isValidGtin(code))) {
        return jsonResponse({ error: 'Only one or two checksum-valid EAN/UPC/GTIN codes are accepted.' }, 400)
      }
      const upstreamUrl = new URL('https://api.upcitemdb.com/prod/trial/lookup')
      upstreamUrl.searchParams.set('upc', barcodes.join(','))
      try {
        const upstream = await fetch(upstreamUrl, { headers: { Accept: 'application/json' } })
        const headers = new Headers(upstream.headers)
        headers.set('Content-Type', 'application/json; charset=utf-8')
        headers.set('Cache-Control', upstream.ok ? 'public, max-age=86400' : 'no-store')
        headers.set('X-Content-Type-Options', 'nosniff')
        return new Response(upstream.body, { status: upstream.status, headers })
      } catch {
        return jsonResponse({ error: 'Product catalog temporarily unavailable' }, 502)
      }
    }

    if (url.pathname === '/api/product/search' && request.method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 100)
      if (query.length < 5) return jsonResponse({ error: 'Search query is too short' }, 400)
      try {
        const upstream = await fetch('https://api.upcitemdb.com/prod/trial/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ s: query, type: 'product', match_mode: 0 }),
        })
        const headers = new Headers(upstream.headers)
        headers.set('Content-Type', 'application/json; charset=utf-8')
        headers.set('Cache-Control', upstream.ok ? 'public, max-age=86400' : 'no-store')
        headers.set('X-Content-Type-Options', 'nosniff')
        return new Response(upstream.body, { status: upstream.status, headers })
      } catch {
        return jsonResponse({ error: 'Product search temporarily unavailable' }, 502)
      }
    }

    return env.ASSETS.fetch(request)
  },
}
