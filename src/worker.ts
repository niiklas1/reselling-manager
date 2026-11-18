interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>
  }
  SUPABASE_URL?: string
  SUPABASE_PUBLISHABLE_KEY?: string
  SUPABASE_SECRET_KEY?: string
  EBAY_CLIENT_ID?: string
  EBAY_CLIENT_SECRET?: string
  EBAY_RU_NAME?: string
  EBAY_TOKEN_ENCRYPTION_KEY?: string
  TRACKING_17TRACK_API_TOKEN?: string
  TRACKING_17TRACK_WEBHOOK_SECRET?: string
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
  qwenScore: number
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
  // For these retrieval models, random unrelated text often has a positive
  // cosine baseline. Scale the useful semantic range instead of treating
  // every unrelated pair as a 0.5 match.
  return Math.max(0, Math.min(1, (value - 0.2) / 0.6))
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

export function qwenVectors(rawValue: unknown, expectedCount: number): number[][] {
  if (!rawValue || typeof rawValue !== 'object') return []
  const raw = rawValue as { data?: unknown; shape?: number[] }
  const values = raw.data
  if (!Array.isArray(values) || values.length !== expectedCount) return []
  const rows = values as unknown[]
  const vectors = rows.map(row => Array.isArray(row) ? row.map(Number) : [])
  return vectors.every(row => row.length > 0 && row.every(Number.isFinite)) ? vectors : []
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
  if (current.count >= 50) return false
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
  if (!candidates.length || candidates.length > 40 || !products.length || products.length > 150) {
    return jsonResponse({ error: 'Der KI-Abgleich unterstützt 1–40 E-Mails und 1–150 Produkte pro Durchlauf.' }, 400)
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
  const rerankerQueries = cleanCandidates.map(candidate => candidate.text)
  const productTexts = cleanProducts.map(product =>
    'Produkt: ' + product.name + '. Kategorie: ' + product.category + '. Shop oder Verkaufsplattform: ' + product.platform
  )
  const total = emailTexts.length + productTexts.length

  const [bgeResult, gemmaResult, qwenResult] = await Promise.allSettled([
    env.AI.run('@cf/baai/bge-m3', { text: [...emailTexts, ...productTexts] }),
    env.AI.run('@cf/google/embeddinggemma-2', {
      input: [
        ...emailTexts.map(text => 'task: search result | query: ' + text),
        ...productTexts.map((text, index) => 'title: ' + cleanProducts[index].name + ' | text: ' + text),
      ],
      dimensions: 768,
    }),
    env.AI.run('@cf/qwen/qwen3-embedding-0.6b', {
      text: [...emailTexts, ...productTexts],
    }),
  ])
  const bge = bgeResult.status === 'fulfilled' ? bgeVectors(bgeResult.value, total) : []
  const gemma = gemmaResult.status === 'fulfilled' ? gemmaVectors(gemmaResult.value, total) : []
  const qwen = qwenResult.status === 'fulfilled' ? qwenVectors(qwenResult.value, total) : []
  const availableModels = [
    ...(bge.length === total ? ['BGE-M3'] : []),
    ...(gemma.length === total ? ['EmbeddingGemma 2'] : []),
    ...(qwen.length === total ? ['Qwen3-Embedding'] : []),
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
      const qwenSimilarity = qwen.length === total
        ? cosineSimilarity(qwen[candidateIndex], qwen[emailTexts.length + productIndex])
        : 0
      const lexicalScore = lexicalSimilarity(candidate.text, product.name + ' ' + product.category)
      const bgeNormalized = bge.length === total ? normalizedCosine(bgeSimilarity) : 0
      const gemmaNormalized = gemma.length === total ? normalizedCosine(gemmaSimilarity) : 0
      const qwenNormalized = qwen.length === total ? normalizedCosine(qwenSimilarity) : 0
      const embeddingScores = [
        ...(bge.length === total ? [bgeNormalized] : []),
        ...(gemma.length === total ? [gemmaNormalized] : []),
        ...(qwen.length === total ? [qwenNormalized] : []),
      ]
      const embeddingAverage = embeddingScores.reduce((sum, score) => sum + score, 0) / embeddingScores.length
      const retrievalScore = embeddingScores.length >= 2
        ? embeddingAverage * 0.84 + lexicalScore * 0.16
        : embeddingAverage * 0.82 + lexicalScore * 0.18
      return { productId: product.id, productIndex, bgeSimilarity, gemmaSimilarity, qwenSimilarity, bgeNormalized, gemmaNormalized, qwenNormalized, lexicalScore, retrievalScore }
    }).sort((left, right) => right.retrievalScore - left.retrievalScore)
    const shortlist = initial.slice(0, Math.min(10, initial.length))
    let reranked: Array<{ id: number; score: number }> = []
    if (shortlist.length) {
      try {
        const raw = await env.AI.run('@cf/baai/bge-reranker-base', {
          query: rerankerQueries[candidateIndex],
          contexts: shortlist.map(item => {
            const product = cleanProducts[item.productIndex]
            return { text: product.name + '. Kategorie: ' + product.category + '. Händler oder Verkaufsplattform: ' + product.platform + '.' }
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
      const availableEmbeddingCount = availableModels.length
      const score = hasReranker
        ? rerankerScore * 0.50 +
          (item.bgeNormalized + item.gemmaNormalized + item.qwenNormalized) * (0.45 / availableEmbeddingCount) +
          item.lexicalScore * 0.05 +
          dateBonus(candidate, cleanProducts[item.productIndex])
        : item.retrievalScore * 0.92 + dateBonus(candidate, cleanProducts[item.productIndex])
      return {
        productId: item.productId,
        score: Math.max(0, Math.min(1, score)),
        rerankerScore,
        bgeScore: item.bgeSimilarity,
        gemmaScore: item.gemmaSimilarity,
        qwenScore: item.qwenSimilarity,
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
    const qwenRank = qwen.length === total
      ? [...initial].sort((left, right) => right.qwenNormalized - left.qwenNormalized).findIndex(item => item.productId === best?.productId)
      : 99
    const availableRanks = [
      ...(bge.length === total ? [bgeRank] : []),
      ...(gemma.length === total ? [gemmaRank] : []),
      ...(qwen.length === total ? [qwenRank] : []),
    ]
    const agreeingModels = availableRanks.filter(rank => rank <= 2).length
    const modelAgreement = agreeingModels >= Math.min(2, availableRanks.length)
    const bestEmbeddingSimilarity = Math.max(
      bge.length === total ? best?.bgeScore || 0 : 0,
      gemma.length === total ? best?.gemmaScore || 0 : 0,
      qwen.length === total ? best?.qwenScore || 0 : 0,
    )
    const enoughEvidence = hasReranker
      ? best.rerankerScore >= 0.05 && (best.lexicalScore >= 0.08 || modelAgreement || best.rerankerScore >= 0.62)
      : modelAgreement && (best.lexicalScore >= 0.18 || bestEmbeddingSimilarity >= 0.78)
    const clearLead = !second || best.score - second.score >= (modelAgreement ? 0.055 : 0.085)
    const approved = Boolean(best && best.score >= (hasReranker ? 0.35 : 0.45) && enoughEvidence && clearLead)
    const reason = approved
      ? modelAgreement && best.rerankerScore >= 0.55
        ? 'Hohe Übereinstimmung: mehrere unabhängige Embedding-Modelle und der Reranker stimmen überein.'
        : hasReranker
          ? 'Semantischer Produktabgleich durch BGE-M3, EmbeddingGemma 2, Qwen3 und direkten Reranker.'
          : 'Vorläufiger Abgleich mit den verfügbaren Embedding-Modellen.'
      : 'Keine ausreichend eindeutige Produktübereinstimmung. Bitte manuell auswählen.'
    return {
      candidateId: candidate.id,
      productId: approved ? best.productId : '',
      score: Number((best?.score || 0).toFixed(4)),
      semanticScore: Number((best ? normalizedCosine(bestEmbeddingSimilarity) : 0).toFixed(4)),
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


// eBay OAuth and account sync. All refresh tokens remain encrypted in Supabase;
// eBay credentials and the encryption key are Cloudflare Worker secrets.
const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.listing.read',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
]
const EBAY_GRAPHQL_URL = 'https://graphqlapi.ebay.com/graphql'
const EBAY_ORDERS_URL = 'https://api.ebay.com/sell/fulfillment/v1/order'
const EBAY_MARKETPLACE = 'EBAY_DE'

type EbayConnectionRow = {
  user_id: string
  refresh_token_ciphertext: string
  refresh_token_iv: string
  refresh_token_expires_at: string | null
  scopes: string[]
  connected_at: string
  last_sync_at: string | null
  last_sync_error: string | null
}
type EbayTokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_token_expires_in?: number
}
type EbayListingRow = {
  user_id: string
  external_listing_id: string
  title: string
  marketplace: string
  status: 'ACTIVE' | 'ENDED' | 'SCHEDULED' | 'SOLD' | 'UNKNOWN'
  listing_format: string | null
  price: number | null
  currency: string | null
  quantity_available: number | null
  quantity_sold: number | null
  listing_url: string
  started_at: string | null
  ended_at: string | null
  last_synced_at: string
}
type EbayOrder = {
  orderId?: string
  creationDate?: string
  orderFulfillmentStatus?: string
  lineItems?: Array<{
    lineItemId?: string
    legacyItemId?: string
    title?: string
    quantity?: number
    lineItemCost?: { value?: string | number; currency?: string }
  }>
}

function ebayJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function getSupabaseConfig(env: Env) {
  const url = env.SUPABASE_URL || 'https://uuvffkcxgxarfaecwjiz.supabase.co'
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || ''
  const secretKey = env.SUPABASE_SECRET_KEY || ''
  if (!publishableKey || !secretKey) {
    throw new Error('Supabase-Backend-Schlüssel fehlen in den Cloudflare Worker Secrets.')
  }
  return { url, publishableKey, secretKey }
}

async function getAuthenticatedEbayUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const authorization = request.headers.get('Authorization') || ''
  const accessToken = authorization.replace(/^Bearer\s+/i, '').trim()
  if (accessToken.length < 20 || accessToken.length > 10000) return null
  const config = getSupabaseConfig(env)
  const response = await fetch(config.url + '/auth/v1/user', {
    headers: {
      apikey: config.publishableKey,
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json',
    },
  })
  if (!response.ok) return null
  const user = await response.json() as { id?: string }
  return typeof user.id === 'string' ? { id: user.id } : null
}

async function supabaseAdminRequest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const config = getSupabaseConfig(env)
  const headers = new Headers(init.headers)
  headers.set('apikey', config.secretKey)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return fetch(config.url + '/rest/v1/' + path, { ...init, headers })
}

async function supabaseAdminJson<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const response = await supabaseAdminRequest(env, path, init)
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600)
    throw new Error('Supabase-Datenbankfehler (' + response.status + '): ' + detail)
  }
  if (response.status === 204) return undefined as T
  const raw = await response.text()
  return (raw ? JSON.parse(raw) : undefined) as T
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
function encodeBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
async function getEbayEncryptionKey(env: Env): Promise<CryptoKey> {
  const encoded = env.EBAY_TOKEN_ENCRYPTION_KEY || ''
  if (!encoded) throw new Error('Der eBay-Verschlüsselungsschlüssel fehlt in den Cloudflare Worker Secrets.')
  const raw = decodeBase64(encoded)
  if (raw.length !== 32) throw new Error('EBAY_TOKEN_ENCRYPTION_KEY muss ein Base64-kodierter 32-Byte-Schlüssel sein.')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function encryptEbayRefreshToken(value: string, env: Env): Promise<{ ciphertext: string; iv: string }> {
  const key = await getEbayEncryptionKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value))
  return { ciphertext: encodeBase64(ciphertext), iv: encodeBase64(iv) }
}
async function decryptEbayRefreshToken(row: EbayConnectionRow, env: Env): Promise<string> {
  const key = await getEbayEncryptionKey(env)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(row.refresh_token_iv) },
    key,
    decodeBase64(row.refresh_token_ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
function ebayConfiguration(env: Env) {
  const clientId = env.EBAY_CLIENT_ID || ''
  const clientSecret = env.EBAY_CLIENT_SECRET || ''
  const ruName = env.EBAY_RU_NAME || ''
  if (!clientId || !clientSecret || !ruName) {
    throw new Error('eBay ist noch nicht vollständig eingerichtet. Es fehlen Client ID, Client Secret oder RuName als Cloudflare Worker Secrets.')
  }
  return { clientId, clientSecret, ruName }
}
function createRandomState(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
async function readEbayConnection(userId: string, env: Env): Promise<EbayConnectionRow | null> {
  const rows = await supabaseAdminJson<EbayConnectionRow[]>(
    env,
    'ebay_connections?select=*&user_id=eq.' + encodeURIComponent(userId) + '&limit=1',
  )
  return rows[0] || null
}
async function saveEbayConnection(env: Env, row: Record<string, unknown>): Promise<void> {
  await supabaseAdminJson(env, 'ebay_connections?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  })
}
async function updateEbaySyncStatus(userId: string, env: Env, values: Record<string, unknown>): Promise<void> {
  await supabaseAdminJson(
    env,
    'ebay_connections?user_id=eq.' + encodeURIComponent(userId),
    { method: 'PATCH', body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }) },
  )
}

async function ebayConnect(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedEbayUser(request, env)
  if (!user) return ebayJson({ error: 'Bitte melde dich im Reselling Manager erneut an.' }, 401)
  try {
    const { clientId, ruName } = ebayConfiguration(env)
    // Validate encryption and database configuration before redirecting.
    await getEbayEncryptionKey(env)
    const state = createRandomState()
    await supabaseAdminJson(env, 'ebay_oauth_states', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: user.id,
        state_hash: await sha256Hex(state),
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    })
    const target = new URL('https://auth.ebay.com/oauth2/authorize')
    target.searchParams.set('client_id', clientId)
    target.searchParams.set('response_type', 'code')
    target.searchParams.set('redirect_uri', ruName)
    target.searchParams.set('scope', EBAY_SCOPES.join(' '))
    target.searchParams.set('state', state)
    target.searchParams.set('locale', 'de-DE')
    return ebayJson({ authorizationUrl: target.toString() })
  } catch (error) {
    return ebayJson({ error: error instanceof Error ? error.message : 'eBay-Verbindung konnte nicht gestartet werden.' }, 503)
  }
}

async function exchangeEbayAuthorizationCode(code: string, env: Env): Promise<EbayTokenResponse> {
  const { clientId, clientSecret, ruName } = ebayConfiguration(env)
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(clientId + ':' + clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ruName,
    }).toString(),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error('eBay-Tokenaustausch fehlgeschlagen (' + response.status + '): ' + raw.slice(0, 300))
  const token = JSON.parse(raw) as EbayTokenResponse
  if (!token.access_token || !token.refresh_token) throw new Error('eBay hat kein gültiges Refresh-Token zurückgegeben.')
  return token
}

async function ebayOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const state = url.searchParams.get('state') || ''
  const code = url.searchParams.get('code') || ''
  const denied = url.searchParams.get('error')
  const appUrl = new URL('/', url.origin)
  if (denied) {
    appUrl.searchParams.set('ebay', 'declined')
    return Response.redirect(appUrl.toString(), 302)
  }
  if (!state || !code || state.length > 300 || code.length > 2048) {
    appUrl.searchParams.set('ebay', 'error')
    return Response.redirect(appUrl.toString(), 302)
  }
  try {
    const stateHash = await sha256Hex(state)
    const rows = await supabaseAdminJson<Array<{ id: string; user_id: string; expires_at: string }>>(
      env,
      'ebay_oauth_states?select=id,user_id,expires_at&state_hash=eq.' + encodeURIComponent(stateHash) + '&limit=1',
    )
    const pending = rows[0]
    if (!pending || Date.parse(pending.expires_at) < Date.now()) {
      appUrl.searchParams.set('ebay', 'error')
      return Response.redirect(appUrl.toString(), 302)
    }
    // Consume state before exchanging the one-use authorization code.
    await supabaseAdminJson(env, 'ebay_oauth_states?id=eq.' + encodeURIComponent(pending.id), { method: 'DELETE' })
    const token = await exchangeEbayAuthorizationCode(code, env)
    const encrypted = await encryptEbayRefreshToken(token.refresh_token!, env)
    await saveEbayConnection(env, {
      user_id: pending.user_id,
      refresh_token_ciphertext: encrypted.ciphertext,
      refresh_token_iv: encrypted.iv,
      refresh_token_expires_at: new Date(Date.now() + Number(token.refresh_token_expires_in || 47304000) * 1000).toISOString(),
      scopes: EBAY_SCOPES,
      connected_at: new Date().toISOString(),
      last_sync_error: null,
      updated_at: new Date().toISOString(),
    })
    appUrl.searchParams.set('ebay', 'connected')
  } catch {
    appUrl.searchParams.set('ebay', 'error')
  }
  return Response.redirect(appUrl.toString(), 302)
}

async function refreshEbayAccessToken(row: EbayConnectionRow, env: Env): Promise<{ accessToken: string; updatedRefreshToken?: string }> {
  const { clientId, clientSecret } = ebayConfiguration(env)
  const refreshToken = await decryptEbayRefreshToken(row, env)
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(clientId + ':' + clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error('eBay-Zugriffstoken konnte nicht erneuert werden (' + response.status + '). Bitte verbinde eBay erneut.')
  const token = JSON.parse(raw) as EbayTokenResponse
  if (!token.access_token) throw new Error('eBay hat kein gültiges Zugriffstoken zurückgegeben.')
  return { accessToken: token.access_token, updatedRefreshToken: token.refresh_token }
}

async function ebayGraphql<T>(accessToken: string, query: string): Promise<T> {
  const response = await fetch(EBAY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query }),
  })
  const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> }
  if (!response.ok || payload.errors?.length || !payload.data) {
    const detail = payload.errors?.map(item => item.message).filter(Boolean).join('; ') || ('HTTP ' + response.status)
    throw new Error('eBay Listing API: ' + detail.slice(0, 400))
  }
  return payload.data
}

async function searchEbayListingIds(accessToken: string): Promise<Array<{ id: string; status: string }>> {
  const query = [
    'query sellerListingSearch {',
    ' activeListings(searchInput: { pagination: { maxPageSize: 50 } }) { ... on SellerListings { listings { listingId } pagination { totalElements } } }',
    ' endedListings(searchInput: { pagination: { maxPageSize: 50 } }) { ... on SellerListings { listings { listingId } pagination { totalElements } } }',
    ' scheduledListings(searchInput: { pagination: { maxPageSize: 50 } }) { ... on SellerListings { listings { listingId } pagination { totalElements } } }',
    '}',
  ].join('\n')
  const data = await ebayGraphql<{
    sellerListingSearch?: {
      activeListings?: { listings?: Array<{ listingId?: string }> }
      endedListings?: { listings?: Array<{ listingId?: string }> }
      scheduledListings?: { listings?: Array<{ listingId?: string }> }
    }
  }>(accessToken, query)
  const result = data.sellerListingSearch
  if (!result) throw new Error('eBay hat keine Listing-Suchergebnisse zurückgegeben.')
  const byId = new Map<string, string>()
  for (const [status, group] of [
    ['ACTIVE', result.activeListings],
    ['ENDED', result.endedListings],
    ['SCHEDULED', result.scheduledListings],
  ] as const) {
    for (const item of group?.listings || []) {
      const id = String(item.listingId || '')
      if (/^\d{8,20}$/.test(id)) byId.set(id, status)
    }
  }
  return [...byId.entries()].map(([id, status]) => ({ id, status })).slice(0, 100)
}

function buildEbayListingDetailQuery(listingId: string): string {
  return [
    'query SellerListings {',
    ' sellerListings(input: { listings: [{ listingId: "' + listingId + '" }] }) {',
    '  listings { ... on ListingSuccess {',
    '   listingId',
    '   listing {',
    '    listingId marketplace sellerProduct { title }',
    '    items { itemTerms { pricingTerms { fixedPrice { original { value currency } } } availability { quantityAvailable } } }',
    '    listingTerms { listingFormat lifecycleTerms { listingStatus startAt actualEndAt } totalQuantityAvailable }',
    '   }',
    '  } }',
    ' }',
    '}',
  ].join('\n')
}

function moneyFromListing(value: any): { price: number | null; currency: string | null; quantity: number | null } {
  const items = Array.isArray(value?.items) ? value.items : []
  const prices: Array<{ price: number; currency: string }> = []
  let quantity = 0
  for (const item of items) {
    const terms = item?.itemTerms || {}
    const money = terms?.pricingTerms?.fixedPrice?.original || terms?.pricingTerms?.fixedPrice
    const numeric = Number(money?.value)
    const currency = String(money?.currency || '')
    if (Number.isFinite(numeric) && currency) prices.push({ price: numeric, currency })
    const available = Number(terms?.availability?.quantityAvailable)
    if (Number.isFinite(available)) quantity += available
  }
  const currencies = [...new Set(prices.map(value => value.currency))]
  const currency = currencies.length === 1 ? currencies[0] : null
  // For listings with variations, expose the lowest available fixed price ("ab").
  const price = prices.length && currency
    ? Math.min(...prices.map(value => value.price))
    : null
  return { price, currency, quantity: items.length ? quantity : null }
}


async function getEbayListingDetail(accessToken: string, id: string, searchStatus: string): Promise<EbayListingRow | null> {
  const data = await ebayGraphql<any>(accessToken, buildEbayListingDetailQuery(id))
  const result = data?.sellerListings?.listings?.[0]
  const listing = result?.listing
  if (!listing) return null
  const lifecycle = listing.listingTerms?.lifecycleTerms || {}
  const status = String(lifecycle.listingStatus || searchStatus || 'UNKNOWN').toUpperCase()
  const amount = moneyFromListing(listing)
  const available = Number(listing.listingTerms?.totalQuantityAvailable)
  return {
    user_id: '',
    external_listing_id: id,
    title: String(listing.sellerProduct?.title || 'eBay-Angebot'),
    marketplace: String(listing.marketplace || EBAY_MARKETPLACE),
    status: ['ACTIVE', 'ENDED', 'SCHEDULED'].includes(status) ? status as EbayListingRow['status'] : searchStatus as EbayListingRow['status'],
    listing_format: String(listing.listingTerms?.listingFormat || '') || null,
    price: amount.price,
    currency: amount.currency,
    quantity_available: Number.isFinite(available) ? available : amount.quantity,
    quantity_sold: null,
    listing_url: 'https://www.ebay.de/itm/' + id,
    started_at: typeof lifecycle.startAt === 'string' ? lifecycle.startAt : null,
    ended_at: typeof lifecycle.actualEndAt === 'string' ? lifecycle.actualEndAt : null,
    last_synced_at: new Date().toISOString(),
  }
}

async function getEbayOrders(accessToken: string, since: Date): Promise<EbayOrder[]> {
  const from = since.toISOString().replace(/\.\d{3}Z$/, '.000Z')
  const to = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z')
  const all: EbayOrder[] = []
  for (let offset = 0; offset < 1000; offset += 200) {
    const target = new URL(EBAY_ORDERS_URL)
    target.searchParams.set('limit', '200')
    target.searchParams.set('offset', String(offset))
    target.searchParams.set('filter', 'creationdate:[' + from + '..' + to + ']')
    const response = await fetch(target, {
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    })
    const raw = await response.text()
    if (!response.ok) throw new Error('eBay-Bestellungen konnten nicht gelesen werden (' + response.status + '): ' + raw.slice(0, 300))
    const payload = JSON.parse(raw) as { orders?: EbayOrder[]; total?: number }
    const orders = Array.isArray(payload.orders) ? payload.orders : []
    all.push(...orders)
    if (!orders.length || orders.length < 200 || (Number(payload.total) > 0 && all.length >= Number(payload.total))) break
  }
  return all
}

async function syncEbayUser(userId: string, env: Env): Promise<{ listings: number; orders: number }> {
  const connection = await readEbayConnection(userId, env)
  if (!connection) throw new Error('Kein eBay-Konto verbunden.')
  const refreshed = await refreshEbayAccessToken(connection, env)
  if (refreshed.updatedRefreshToken) {
    const encrypted = await encryptEbayRefreshToken(refreshed.updatedRefreshToken, env)
    await saveEbayConnection(env, {
      user_id: userId,
      refresh_token_ciphertext: encrypted.ciphertext,
      refresh_token_iv: encrypted.iv,
      updated_at: new Date().toISOString(),
    })
  }

  const listingIds = await searchEbayListingIds(refreshed.accessToken)
  const listingRows: EbayListingRow[] = []
  for (let index = 0; index < listingIds.length; index += 5) {
    const group = await Promise.all(listingIds.slice(index, index + 5).map(async item => {
      try { return await getEbayListingDetail(refreshed.accessToken, item.id, item.status) }
      catch { return null }
    }))
    for (const listing of group) if (listing) {
      listing.user_id = userId
      listingRows.push(listing)
    }
  }
  if (listingRows.length) {
    await supabaseAdminJson(env, 'ebay_listings?on_conflict=user_id,external_listing_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(listingRows),
    })
  }

  const orderStart = connection.last_sync_at
    ? new Date(Math.max(Date.parse(connection.last_sync_at) - 7 * 86400000, Date.now() - 90 * 86400000))
    : new Date(Date.now() - 90 * 86400000)
  const orders = await getEbayOrders(refreshed.accessToken, orderStart)
  const orderRows = orders.flatMap(order => (order.lineItems || []).map(line => {
    const id = String(line.legacyItemId || '')
    const amount = Number(line.lineItemCost?.value)
    return {
      user_id: userId,
      external_order_id: String(order.orderId || ''),
      line_item_id: String(line.lineItemId || line.legacyItemId || ''),
      external_listing_id: /^\d{8,20}$/.test(id) ? id : null,
      title: String(line.title || 'eBay-Verkauf'),
      quantity: Math.max(1, Number(line.quantity || 1)),
      amount: Number.isFinite(amount) ? amount : null,
      currency: String(line.lineItemCost?.currency || '').slice(0, 3) || null,
      order_status: String(order.orderFulfillmentStatus || ''),
      sold_at: order.creationDate || null,
      last_synced_at: new Date().toISOString(),
    }
  })).filter(row => row.external_order_id && row.line_item_id)
  if (orderRows.length) {
    await supabaseAdminJson(env, 'ebay_orders?on_conflict=user_id,external_order_id,line_item_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(orderRows),
    })
  }
  await updateEbaySyncStatus(userId, env, {
    last_sync_at: new Date().toISOString(),
    last_sync_error: null,
  })
  return { listings: listingRows.length, orders: orderRows.length }
}

async function ebayStatus(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedEbayUser(request, env)
  if (!user) return ebayJson({ error: 'Bitte melde dich im Reselling Manager erneut an.' }, 401)
  try {
    const connection = await readEbayConnection(user.id, env)
    return ebayJson({
      connected: Boolean(connection),
      connectedAt: connection?.connected_at || null,
      lastSyncAt: connection?.last_sync_at || null,
      lastSyncError: connection?.last_sync_error || null,
    })
  } catch (error) {
    return ebayJson({ error: error instanceof Error ? error.message : 'eBay-Status konnte nicht gelesen werden.' }, 503)
  }
}

async function ebayListings(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedEbayUser(request, env)
  if (!user) return ebayJson({ error: 'Bitte melde dich im Reselling Manager erneut an.' }, 401)
  try {
    const rows = await supabaseAdminJson<EbayListingRow[]>(
      env,
      'ebay_listings?select=external_listing_id,title,marketplace,status,listing_format,price,currency,quantity_available,quantity_sold,listing_url,started_at,ended_at,last_synced_at&user_id=eq.' + encodeURIComponent(user.id) + '&order=last_synced_at.desc&limit=250',
    )
    const orders = await supabaseAdminJson<any[]>(
      env,
      'ebay_orders?select=external_order_id,line_item_id,external_listing_id,title,quantity,amount,currency,order_status,sold_at&user_id=eq.' + encodeURIComponent(user.id) + '&order=sold_at.desc&limit=100',
    )
    return ebayJson({ listings: rows, orders })
  } catch (error) {
    return ebayJson({ error: error instanceof Error ? error.message : 'eBay-Daten konnten nicht gelesen werden.' }, 503)
  }
}

async function ebaySync(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedEbayUser(request, env)
  if (!user) return ebayJson({ error: 'Bitte melde dich im Reselling Manager erneut an.' }, 401)
  try {
    const result = await syncEbayUser(user.id, env)
    return ebayJson({ ok: true, ...result, syncedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'eBay-Synchronisierung fehlgeschlagen.'
    try { await updateEbaySyncStatus(user.id, env, { last_sync_error: message.slice(0, 500) }) } catch { /* keep original error */ }
    return ebayJson({ error: message }, 502)
  }
}

async function ebayDisconnect(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedEbayUser(request, env)
  if (!user) return ebayJson({ error: 'Bitte melde dich im Reselling Manager erneut an.' }, 401)
  try {
    await supabaseAdminJson(env, 'ebay_connections?user_id=eq.' + encodeURIComponent(user.id), { method: 'DELETE' })
    await supabaseAdminJson(env, 'ebay_oauth_states?user_id=eq.' + encodeURIComponent(user.id), { method: 'DELETE' })
    return ebayJson({ ok: true })
  } catch (error) {
    return ebayJson({ error: error instanceof Error ? error.message : 'eBay konnte nicht getrennt werden.' }, 503)
  }
}


type ShippingProductRow = {
  id: string
  name: string
  status: string
  sale_date: string | null
  incoming_carrier: string | null
  incoming_tracking_number: string | null
  incoming_tracking_url: string | null
  outgoing_carrier: string | null
  outgoing_tracking_number: string | null
  outgoing_tracking_url: string | null
}
type ShippingTrackingRow = {
  id: string
  user_id: string
  product_id: string
  direction: 'incoming' | 'outgoing'
  tracking_number: string
  carrier: string
  tracking_url: string
  provider: string
  provider_carrier: number | null
  provider_registered: boolean
  tracking_status: string
  provider_status: string | null
  provider_sub_status: string | null
  latest_event: string | null
  latest_location: string | null
  latest_event_at: string | null
  estimated_delivery_from: string | null
  estimated_delivery_to: string | null
  last_synced_at: string | null
  tracking_error: string | null
  updated_at: string
}
type TrackingApiRecord = Record<string, unknown>
type TrackingApiResponse = {
  code?: number
  data?: {
    accepted?: TrackingApiRecord[]
    rejected?: Array<{ number?: string; error?: { code?: number; message?: string } }>
  }
}

function trackingObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
function trackingString(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : ''
}
function trackingIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

export function normalizeShippingStatus(statusValue: unknown, subStatusValue?: unknown, daysSinceUpdate?: unknown): string {
  const status = trackingString(statusValue, 60).toLowerCase()
  const subStatus = trackingString(subStatusValue, 100).toLowerCase()
  if (status === 'delivered') return 'delivered'
  if (status === 'returned' || status === 'returning' || subStatus.includes('return')) return 'returned'
  if (status === 'exception' || status === 'deliveryfailure') return 'attention'
  if (status === 'outfordelivery') return 'out_for_delivery'
  if (status === 'availableforpickup') return 'available_for_pickup'
  if (status === 'intransit') {
    const idleDays = Number(daysSinceUpdate)
    return Number.isFinite(idleDays) && idleDays >= 5 ? 'stale' : 'in_transit'
  }
  if (status === 'inforeceived') return 'label_created'
  if (status === 'notfound') return 'not_found'
  if (status === 'expired') return 'stale'
  return 'unknown'
}

function parsed17TrackResult(record: TrackingApiRecord): {
  tracking_status: string
  provider_status: string | null
  provider_sub_status: string | null
  latest_event: string | null
  latest_location: string | null
  latest_event_at: string | null
  estimated_delivery_from: string | null
  estimated_delivery_to: string | null
} {
  const trackInfo = trackingObject(record.track_info)
  const latestStatus = trackingObject(trackInfo.latest_status)
  const latestEvent = trackingObject(trackInfo.latest_event)
  const translation = trackingObject(latestEvent.description_translation)
  const metrics = trackingObject(trackInfo.time_metrics)
  const estimated = trackingObject(metrics.estimated_delivery_date)
  const rawStatus = trackingString(latestStatus.status, 60) || null
  const rawSubStatus = trackingString(latestStatus.sub_status, 100) || null
  const latestDescription = trackingString(translation.description || latestEvent.description, 500) || null
  return {
    tracking_status: normalizeShippingStatus(rawStatus, rawSubStatus, metrics.days_after_last_update),
    provider_status: rawStatus,
    provider_sub_status: rawSubStatus,
    latest_event: latestDescription,
    latest_location: trackingString(latestEvent.location, 180) || null,
    latest_event_at: trackingIso(latestEvent.time_utc || latestEvent.time_iso),
    estimated_delivery_from: trackingIso(estimated.from),
    estimated_delivery_to: trackingIso(estimated.to),
  }
}

async function call17Track(env: Env, endpoint: 'register' | 'gettrackinfo', items: Array<Record<string, unknown>>): Promise<TrackingApiResponse> {
  const token = env.TRACKING_17TRACK_API_TOKEN || ''
  if (!token) throw new Error('Der 17TRACK API-Token ist noch nicht als Cloudflare Worker Secret eingerichtet.')
  const response = await fetch('https://api.17track.net/track/v2.4/' + endpoint, {
    method: 'POST',
    headers: {
      '17token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(items),
  })
  const payload = await response.json().catch(() => ({})) as TrackingApiResponse
  if (!response.ok || payload.code !== 0) {
    const rejected = payload.data?.rejected?.[0]?.error?.message
    throw new Error(trackingString(rejected, 300) || '17TRACK hat die Anfrage mit Status ' + response.status + ' abgelehnt.')
  }
  return payload
}

async function updateShippingTracking(env: Env, id: string, patch: Record<string, unknown>): Promise<void> {
  await supabaseAdminJson(env, 'shipping_trackings?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  })
}

async function shippingStatus(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedEbayUser(request, env)
  if (!user) return ebayJson({ error: 'Bitte melde dich im Reselling Manager erneut an.' }, 401)
  try {
    const rows = await supabaseAdminJson<ShippingTrackingRow[]>(
      env,
      'shipping_trackings?select=id,product_id,direction,tracking_number,carrier,tracking_url,provider_registered,provider_carrier,tracking_status,provider_status,provider_sub_status,latest_event,latest_location,latest_event_at,estimated_delivery_from,estimated_delivery_to,last_synced_at,tracking_error&user_id=eq.' + encodeURIComponent(user.id) + '&order=updated_at.desc&limit=1000',
    )
    const apiAvailable = Boolean(env.TRACKING_17TRACK_API_TOKEN)
    const webhookConfigured = Boolean(env.TRACKING_17TRACK_WEBHOOK_SECRET || env.TRACKING_17TRACK_API_TOKEN)
    return ebayJson({
      apiAvailable,
      webhookConfigured,
      liveTrackingEnabled: apiAvailable && webhookConfigured,
      provider: '17TRACK',
      trackings: rows,
    })
  } catch (error) {
    return ebayJson({ error: error instanceof Error ? error.message : 'Versandstatus konnte nicht geladen werden.' }, 503)
  }
}

async function shippingSync(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedEbayUser(request, env)
  if (!user) return ebayJson({ error: 'Bitte melde dich im Reselling Manager erneut an.' }, 401)
  if (!env.TRACKING_17TRACK_API_TOKEN) {
    return ebayJson({ error: 'Live-Tracking ist noch nicht eingerichtet. Hinterlege zuerst den 17TRACK API-Token als Cloudflare Worker Secret.' }, 503)
  }

  try {
    const products = await supabaseAdminJson<ShippingProductRow[]>(
      env,
      'products?select=id,name,status,sale_date,incoming_carrier,incoming_tracking_number,incoming_tracking_url,outgoing_carrier,outgoing_tracking_number,outgoing_tracking_url&user_id=eq.' + encodeURIComponent(user.id) + '&deleted_at=is.null&limit=1000',
    )
    const existing = await supabaseAdminJson<ShippingTrackingRow[]>(
      env,
      'shipping_trackings?select=*&user_id=eq.' + encodeURIComponent(user.id) + '&limit=1000',
    )
    const existingByKey = new Map(existing.map(row => [row.product_id + ':' + row.direction, row]))
    const desiredRows: ShippingTrackingRow[] = []
    const now = new Date().toISOString()

    for (const product of products) {
      const directions: Array<{ direction: 'incoming' | 'outgoing'; number: string | null; carrier: string | null; url: string | null }> = [
        {
          direction: 'incoming',
          number: product.incoming_tracking_number,
          carrier: product.incoming_carrier,
          url: product.incoming_tracking_url,
        },
        {
          direction: 'outgoing',
          number: product.outgoing_tracking_number,
          carrier: product.outgoing_carrier,
          url: product.outgoing_tracking_url,
        },
      ]
      for (const item of directions) {
        const number = trackingString(item.number, 120)
        if (!number) continue
        const key = product.id + ':' + item.direction
        const previous = existingByKey.get(key)
        const sameNumber = previous?.tracking_number === number
        desiredRows.push({
          id: sameNumber && previous ? previous.id : crypto.randomUUID(),
          user_id: user.id,
          product_id: product.id,
          direction: item.direction,
          tracking_number: number,
          carrier: trackingString(item.carrier, 100) || '',
          tracking_url: trackingString(item.url, 1000) || '',
          provider: '17track',
          provider_carrier: sameNumber && previous ? previous.provider_carrier : null,
          provider_registered: sameNumber && previous ? previous.provider_registered : false,
          tracking_status: sameNumber && previous ? previous.tracking_status : 'unknown',
          provider_status: sameNumber && previous ? previous.provider_status : null,
          provider_sub_status: sameNumber && previous ? previous.provider_sub_status : null,
          latest_event: sameNumber && previous ? previous.latest_event : null,
          latest_location: sameNumber && previous ? previous.latest_location : null,
          latest_event_at: sameNumber && previous ? previous.latest_event_at : null,
          estimated_delivery_from: sameNumber && previous ? previous.estimated_delivery_from : null,
          estimated_delivery_to: sameNumber && previous ? previous.estimated_delivery_to : null,
          last_synced_at: sameNumber && previous ? previous.last_synced_at : null,
          tracking_error: sameNumber && previous ? previous.tracking_error : null,
          updated_at: now,
        })
      }
    }

    const desiredIds = new Set(desiredRows.map(row => row.id))
    const staleIds = existing.filter(row => !desiredIds.has(row.id)).map(row => row.id)
    if (staleIds.length) {
      await supabaseAdminJson(env, 'shipping_trackings?user_id=eq.' + encodeURIComponent(user.id) + '&id=in.(' + staleIds.join(',') + ')', {
        method: 'DELETE',
      })
    }
    if (desiredRows.length) {
      await supabaseAdminJson(env, 'shipping_trackings?on_conflict=user_id,product_id,direction', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(desiredRows),
      })
    }

    const pending = desiredRows.filter(row => !row.provider_registered && !row.tracking_error)
    let registered = 0
    const acceptedIds = new Set<string>()
    for (let offset = 0; offset < pending.length; offset += 40) {
      const batch = pending.slice(offset, offset + 40)
      const result = await call17Track(env, 'register', batch.map(row => ({
        number: row.tracking_number,
        tag: 'rm:' + row.id,
        lang: 'de',
      })))
      const accepted = result.data?.accepted || []
      const rejected = result.data?.rejected || []
      for (const item of accepted) {
        const number = trackingString(item.number, 120)
        const tag = trackingString(item.tag, 100)
        const id = tag.startsWith('rm:') ? tag.slice(3) : batch.find(row => row.tracking_number === number)?.id
        if (!id) continue
        acceptedIds.add(id)
        await updateShippingTracking(env, id, {
          provider_registered: true,
          provider_carrier: Number.isFinite(Number(item.carrier)) ? Number(item.carrier) : null,
          tracking_error: null,
        })
        registered++
      }
      for (const item of rejected) {
        const number = trackingString(item.number, 120)
        const row = batch.find(entry => entry.tracking_number === number)
        if (row) {
          if (Number(item.error?.code) === -18019901) {
            acceptedIds.add(row.id)
            await updateShippingTracking(env, row.id, {
              provider_registered: true,
              tracking_error: null,
            })
          } else {
            await updateShippingTracking(env, row.id, {
              tracking_error: trackingString(item.error?.message, 400) || '17TRACK konnte die Sendungsnummer nicht registrieren.',
            })
          }
        }
      }
    }

    // By default, fetch only the first result after registering new numbers.
    // A deliberate manual refresh may re-query every active registered shipment.
    const requestBody = await request.clone().json().catch(() => ({})) as { forceRefresh?: boolean }
    let registeredRows = desiredRows.filter(row => acceptedIds.has(row.id))
    if (requestBody.forceRefresh) {
      registeredRows = await supabaseAdminJson<ShippingTrackingRow[]>(
        env,
        'shipping_trackings?select=id,user_id,product_id,direction,tracking_number,carrier,tracking_url,provider,provider_carrier,provider_registered,tracking_status,provider_status,provider_sub_status,latest_event,latest_location,latest_event_at,estimated_delivery_from,estimated_delivery_to,last_synced_at,tracking_error,updated_at&user_id=eq.' + encodeURIComponent(user.id) + '&provider_registered=eq.true&tracking_status=neq.delivered&limit=1000',
      )
    }
    let updated = 0
    for (let offset = 0; offset < registeredRows.length; offset += 40) {
      const batch = registeredRows.slice(offset, offset + 40)
      const result = await call17Track(env, 'gettrackinfo', batch.map(row => ({
        number: row.tracking_number,
        ...(row.provider_carrier ? { carrier: row.provider_carrier } : {}),
      })))
      const accepted = result.data?.accepted || []
      for (const item of accepted) {
        const number = trackingString(item.number, 120)
        const tag = trackingString(item.tag, 100)
        const row = (tag.startsWith('rm:') ? batch.find(entry => entry.id === tag.slice(3)) : undefined)
          || batch.find(entry => entry.tracking_number === number)
        if (!row) continue
        await updateShippingTracking(env, row.id, {
          ...parsed17TrackResult(item),
          provider_registered: true,
          tracking_error: null,
          last_synced_at: new Date().toISOString(),
        })
        updated++
      }
      for (const item of result.data?.rejected || []) {
        const number = trackingString(item.number, 120)
        const row = batch.find(entry => entry.tracking_number === number)
        if (row && item.error?.code !== -18019909) {
          await updateShippingTracking(env, row.id, {
            tracking_error: trackingString(item.error?.message, 400) || 'Tracking-Informationen sind noch nicht verfügbar.',
            last_synced_at: new Date().toISOString(),
          })
        }
      }
    }

    return ebayJson({
      ok: true,
      total: desiredRows.length,
      registered,
      updated,
      syncedAt: new Date().toISOString(),
    })
  } catch (error) {
    return ebayJson({ error: error instanceof Error ? error.message : 'Die Sendungen konnten nicht synchronisiert werden.' }, 502)
  }
}

function secureStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

export async function verify17TrackWebhookSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody + '/' + secret))
  const expected = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return secureStringEqual(signature.toLowerCase().replace(/^sha256=/, ''), expected)
}

async function shippingWebhook(request: Request, env: Env): Promise<Response> {
  const secret = env.TRACKING_17TRACK_WEBHOOK_SECRET || env.TRACKING_17TRACK_API_TOKEN || ''
  if (!secret) return ebayJson({ error: '17TRACK Webhook-Sicherheitsschlüssel ist nicht eingerichtet.' }, 503)
  const rawBody = await request.text()
  if (rawBody.length > 500000) return ebayJson({ error: 'Webhook-Anfrage ist zu groß.' }, 413)
  const signature = request.headers.get('sign') || ''
  if (!(await verify17TrackWebhookSignature(rawBody, signature, secret))) {
    return ebayJson({ error: 'Ungültige 17TRACK-Signatur.' }, 401)
  }
  try {
    const payload = JSON.parse(rawBody) as {
      event?: string
      data?: { accepted?: TrackingApiRecord[] }
    }
    if (payload.event !== 'TRACKING_UPDATED') return ebayJson({ ok: true, ignored: true })
    const accepted = Array.isArray(payload.data?.accepted) ? payload.data.accepted : []
    let updated = 0
    for (const item of accepted) {
      const tag = trackingString(item.tag, 100)
      if (!tag.startsWith('rm:')) continue
      const id = tag.slice(3)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue
      await updateShippingTracking(env, id, {
        ...parsed17TrackResult(item),
        provider_registered: true,
        tracking_error: null,
        last_synced_at: new Date().toISOString(),
      })
      updated++
    }
    return ebayJson({ ok: true, updated })
  } catch (error) {
    return ebayJson({ error: error instanceof Error ? error.message : '17TRACK Webhook konnte nicht verarbeitet werden.' }, 400)
  }
}

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET || !env.EBAY_RU_NAME ||
        !env.EBAY_TOKEN_ENCRYPTION_KEY || !env.SUPABASE_SECRET_KEY) return
    const rows = await supabaseAdminJson<EbayConnectionRow[]>(
      env,
      'ebay_connections?select=user_id,refresh_token_ciphertext,refresh_token_iv,refresh_token_expires_at,scopes,connected_at,last_sync_at,last_sync_error&limit=250',
    )
    for (const row of rows) {
      try { await syncEbayUser(row.user_id, env) }
      catch (error) {
        const message = error instanceof Error ? error.message : 'eBay-Synchronisierung fehlgeschlagen.'
        try { await updateEbaySyncStatus(row.user_id, env, { last_sync_error: message.slice(0, 500) }) } catch { /* isolate users */ }
      }
    }
  },
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

    if (url.pathname === '/api/ebay/callback' && request.method === 'GET') {
      return ebayOAuthCallback(request, env)
    }
    if (url.pathname === '/api/ebay/status' && request.method === 'GET') {
      return ebayStatus(request, env)
    }
    if (url.pathname === '/api/ebay/connect' && request.method === 'POST') {
      return ebayConnect(request, env)
    }
    if (url.pathname === '/api/ebay/sync' && request.method === 'POST') {
      return ebaySync(request, env)
    }
    if (url.pathname === '/api/ebay/listings' && request.method === 'GET') {
      return ebayListings(request, env)
    }
    if (url.pathname === '/api/ebay/disconnect' && request.method === 'POST') {
      return ebayDisconnect(request, env)
    }
    if (url.pathname === '/api/shipping/status' && request.method === 'GET') {
      return shippingStatus(request, env)
    }
    if (url.pathname === '/api/shipping/sync' && request.method === 'POST') {
      return shippingSync(request, env)
    }
    if (url.pathname === '/api/shipping/webhook' && request.method === 'POST') {
      return shippingWebhook(request, env)
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
