interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>
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
type RankedModelMatch = {
  productId: string
  score: number
  rerankerScore: number
  bgeScore: number
  gemmaScore: number
  lexicalScore: number
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

function normalizedCosine(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2))
}

function bgeVectors(rawValue: unknown, expectedCount: number): number[][] {
  if (!rawValue || typeof rawValue !== 'object') return []
  const raw = rawValue as { data?: unknown; embeddings?: unknown; shape?: number[] }
  const values = raw.data ?? raw.embeddings
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

function gemmaVectors(rawValue: unknown, expectedCount: number): number[][] {
  if (!rawValue || typeof rawValue !== 'object') return []
  const raw = rawValue as { data?: unknown }
  if (!Array.isArray(raw.data) || raw.data.length !== expectedCount) return []
  const indexed: number[][] = Array.from({ length: expectedCount }, () => [])
  for (const item of raw.data as Array<{ index?: number; embedding?: number[] }>) {
    const index = Number(item?.index)
    const embedding = item?.embedding
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount || !Array.isArray(embedding)) return []
    indexed[index] = embedding.map(Number)
  }
  return indexed.every(row => row.length > 0 && row.every(Number.isFinite)) ? indexed : []
}

function rerankerResults(rawValue: unknown): Array<{ id: number; score: number }> {
  if (!rawValue || typeof rawValue !== 'object') return []
  const raw = rawValue as { response?: unknown }
  if (!Array.isArray(raw.response)) return []
  return raw.response.map((item: any) => ({
    id: Number(item?.id),
    score: Number(item?.score),
  })).filter(item => Number.isInteger(item.id) && Number.isFinite(item.score))
}

function dateBonus(candidate: MatchCandidate, product: MatchProduct): number {
  const messageTime = Date.parse(candidate.date || '')
  const purchaseTime = Date.parse(product.purchaseDate || '')
  const saleTime = Date.parse(product.saleDate || '')
  const referenceTime = candidate.direction === 'outgoing' ? saleTime : purchaseTime
  if (!Number.isFinite(messageTime) || !Number.isFinite(referenceTime)) return 0
  const days = (messageTime - referenceTime) / 86400000
  if (candidate.direction === 'incoming') {
    if (days >= -2 && days <= 75) return 0.025
    if (days < -30 || days > 180) return -0.02
  } else {
    if (days >= -2 && days <= 45) return 0.03
    if (days < -30 || days > 120) return -0.02
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

  // Verify the short-lived token with Google. It is never persisted or logged.
  const verification = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  })
  if (!verification.ok) return jsonResponse({ error: 'Die Gmail-Berechtigung ist abgelaufen. Bitte verbinde Gmail erneut.' }, 401)
  if (!(await allowAiRequest(token))) return jsonResponse({ error: 'Zu viele KI-Abgleiche in kurzer Zeit. Bitte versuche es später erneut.' }, 429)

  const rawBody = await request.text()
  if (rawBody.length > 140000) return jsonResponse({ error: 'Die KI-Anfrage ist zu groß. Bitte reduziere die Anzahl der Treffer.' }, 413)
  let body: { candidates?: MatchCandidate[]; products?: MatchProduct[] }
  try {
    body = JSON.parse(rawBody) as typeof body
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

  // Keep carrier/merchant domain as a secondary clue. The dedicated reranker
  // query excludes it so a seller name alone cannot dominate the product match.
  const emailTexts = cleanCandidates.map(candidate =>
    'Versand-E-Mail. Betreff und Nachricht: ' + candidate.text + '. Absender-Domain: ' + candidate.senderDomain +
    '. Richtung: ' + (candidate.direction === 'incoming' ? 'Einkauf, Paket zum Nutzer' : 'Verkauf, Paket vom Nutzer')
  )
  const rerankerQueries = cleanCandidates.map(candidate =>
    'Relevantes Produkt zu dieser Versand-E-Mail finden: ' + candidate.text
  )
  const productTexts = cleanProducts.map(product =>
    'Produkt: ' + product.name + '. Kategorie: ' + product.category + '. Shop oder Verkaufsplattform: ' + product.platform
  )
  const total = emailTexts.length + productTexts.length

  const [bgeResult, gemmaResult] = await Promise.allSettled([
    env.AI.run('@cf/baai/bge-m3', { text: [...emailTexts, ...productTexts] }),
    env.AI.run('@cf/google/embeddinggemma-2', {
      input: [
        ...emailTexts.map(text => 'task: search query | query: ' + text),
        ...productTexts.map((text, index) => 'task: search document | title: ' + cleanProducts[index].name + ' | text: ' + text),
      ],
      dimensions: 768,
    }),
  ])
  const bge = bgeResult.status === 'fulfilled' ? bgeVectors(bgeResult.value, total) : []
  const gemma = gemmaResult.status === 'fulfilled' ? gemmaVectors(gemmaResult.value, total) : []
  const availableModels = [
    ...(bge.length === total ? ['BGE-M3'] : []),
    ...(gemma.length === total ? ['EmbeddingGemma 2'] : []),
  ]
  if (!availableModels.length) {
    return jsonResponse({ error: 'Die Embedding-Modelle sind momentan nicht erreichbar. Die lokale Gmail-Erkennung bleibt verfügbar.' }, 503)
  }

  const matches = await Promise.all(cleanCandidates.map(async (candidate, candidateIndex) => {
    const initial = cleanProducts.map((product, productIndex) => {
      const bgeSimilarity = bge.length === total
        ? cosineSimilarity(bge[candidateIndex], bge[emailTexts.length + productIndex])
        : 0
      const gemmaSimilarity = gemma.length === total
        ? cosineSimilarity(gemma[candidateIndex], gemma[emailTexts.length + productIndex])
        : 0
      const lexicalScore = lexicalSimilarity(candidate.text, product.name + ' ' + product.category)
      const bgeNormalized = bge.length === total ? normalizedCosine(bgeSimilarity) : 0
      const gemmaNormalized = gemma.length === total ? normalizedCosine(gemmaSimilarity) : 0
      const retrievalScore = bge.length === total && gemma.length === total
        ? bgeNormalized * 0.42 + gemmaNormalized * 0.42 + lexicalScore * 0.16
        : (bge.length === total ? bgeNormalized : gemmaNormalized) * 0.82 + lexicalScore * 0.18
      return { productId: product.id, productIndex, bgeSimilarity, gemmaSimilarity, bgeNormalized, gemmaNormalized, lexicalScore, retrievalScore }
    }).sort((left, right) => right.retrievalScore - left.retrievalScore)
    const shortlist = initial.slice(0, Math.min(10, initial.length))
    let reranked: Array<{ id: number; score: number }> = []
    if (shortlist.length) {
      try {
        const raw = await env.AI.run('@cf/baai/bge-reranker-base', {
          query: rerankerQueries[candidateIndex],
          contexts: shortlist.map(item => {
            const product = cleanProducts[item.productIndex]
            return { text: 'Name: ' + product.name + '. Kategorie: ' + product.category + '. Plattform oder Shop: ' + product.platform }
          }),
          top_k: shortlist.length,
        })
        reranked = rerankerResults(raw)
      } catch {
        reranked = []
      }
    }
    const rankById = new Map(reranked.map(item => [item.id, item.score]))
    const hasReranker = reranked.length > 0
    const ranked: RankedModelMatch[] = shortlist.map((item, shortlistIndex) => {
      const rerankerScore = rankById.get(shortlistIndex) ?? 0
      const score = hasReranker
        ? rerankerScore * 0.60 + item.gemmaNormalized * 0.14 + item.bgeNormalized * 0.12 +
          item.lexicalScore * 0.10 + dateBonus(candidate, cleanProducts[item.productIndex])
        : item.retrievalScore * 0.92 + dateBonus(candidate, cleanProducts[item.productIndex])
      return {
        productId: item.productId,
        score: Math.max(0, Math.min(1, score)),
        rerankerScore,
        bgeScore: item.bgeSimilarity,
        gemmaScore: item.gemmaSimilarity,
        lexicalScore: item.lexicalScore,
      }
    }).sort((left, right) => right.score - left.score)

    const best = ranked[0]
    const second = ranked[1]
    const bgeRank = bge.length === total
      ? [...initial].sort((left, right) => right.bgeNormalized - left.bgeNormalized).findIndex(item => item.productId === best?.productId)
      : 99
    const gemmaRank = gemma.length === total
      ? [...initial].sort((left, right) => right.gemmaNormalized - left.gemmaNormalized).findIndex(item => item.productId === best?.productId)
      : 99
    const modelAgreement = bge.length === total && gemma.length === total
      ? bgeRank <= 2 && gemmaRank <= 2
      : bge.length === total ? bgeRank <= 1 : gemmaRank <= 1
    const enoughEvidence = hasReranker
      ? best.rerankerScore >= 0.22 && (best.lexicalScore >= 0.08 || modelAgreement || best.rerankerScore >= 0.62)
      : modelAgreement && (best.lexicalScore >= 0.18 || normalizedCosine(Math.max(best.bgeScore, best.gemmaScore)) >= 0.82)
    const clearLead = !second || best.score - second.score >= (modelAgreement ? 0.055 : 0.085)
    const approved = Boolean(best && best.score >= (hasReranker ? 0.48 : 0.62) && enoughEvidence && clearLead)
    const reason = approved
      ? modelAgreement && best.rerankerScore >= 0.55
        ? 'Hohe Übereinstimmung: beide Embedding-Modelle und der Reranker stimmen überein.'
        : hasReranker
          ? 'Semantischer Produktabgleich durch BGE-M3, EmbeddingGemma 2 und direkten Reranker.'
          : 'Vorläufiger Abgleich mit den verfügbaren Embedding-Modellen.'
      : 'Keine ausreichend eindeutige Produktübereinstimmung. Bitte manuell auswählen.'
    return {
      candidateId: candidate.id,
      productId: approved ? best.productId : '',
      score: Number((best?.score || 0).toFixed(4)),
      semanticScore: Number((best ? Math.max(normalizedCosine(best.bgeScore), normalizedCosine(best.gemmaScore)) : 0).toFixed(4)),
      lexicalScore: Number((best?.lexicalScore || 0).toFixed(4)),
      rerankerScore: Number((best?.rerankerScore || 0).toFixed(4)),
      modelAgreement,
      reason,
    }
  }))
  return jsonResponse({
    modelsUsed: [...availableModels, ...(matches.some(match => match.rerankerScore > 0) ? ['BGE-Reranker'] : [])],
    matches,
  })
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
