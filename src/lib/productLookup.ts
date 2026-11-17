import type { InvoiceLineItem } from './invoiceScanner'

type CatalogItem = {
  ean?: string
  upc?: string
  gtin?: string
  title?: string
  brand?: string
}
type CatalogResponse = { code?: string; items?: CatalogItem[] }
type CacheRecord = { expiresAt: number; value: CatalogItem[] }

const CACHE_KEY = 'reselling-product-catalog-cache-v1'
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000
const SEARCH_TTL = 24 * 60 * 60 * 1000

// Manually corroborated by multiple retailer records carrying this exact EAN.
const VERIFIED_BARCODE_CATALOG: Record<string, CatalogItem> = {
  '196214147454': {
    upc: '196214147454',
    ean: '0196214147454',
    title: 'Pokémon 30 Jahre Ditto Premium-Kollektion DE',
    brand: 'Pokémon',
  },
}
const RATE_KEY = 'reselling-upcitemdb-rate-v1'
const MIN_API_INTERVAL = 10_000
const DAILY_SOFT_LIMIT = 90

async function reserveFreeApiRequest(isSearch: boolean): Promise<boolean> {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const usage = JSON.parse(localStorage.getItem(RATE_KEY) || '{}') as {
      day?: string
      count?: number
      searchCount?: number
      lastAt?: number
    }
    const count = usage.day === today ? Number(usage.count || 0) : 0
    const searchCount = usage.day === today ? Number(usage.searchCount || 0) : 0
    if (count >= DAILY_SOFT_LIMIT || (isSearch && searchCount >= 18)) return false
    const wait = Math.max(0, Number(usage.lastAt || 0) + MIN_API_INTERVAL - Date.now())
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
    localStorage.setItem(RATE_KEY, JSON.stringify({
      day: today,
      count: count + 1,
      searchCount: searchCount + (isSearch ? 1 : 0),
      lastAt: Date.now(),
    }))
    return true
  } catch {
    // Storage can be unavailable in private browsing; still try one request.
    return true
  }
}

function readCache(key: string): CatalogItem[] | null {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, CacheRecord>
    const record = cache[key]
    if (!record || record.expiresAt < Date.now() || !Array.isArray(record.value)) return null
    return record.value
  } catch {
    return null
  }
}

function writeCache(key: string, value: CatalogItem[], ttl = CACHE_TTL): void {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, CacheRecord>
    cache[key] = { expiresAt: Date.now() + ttl, value }
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(Object.entries(cache).slice(-150))))
  } catch {
    // Private browsing or a full storage quota must never block receipt capture.
  }
}

function equivalentBarcode(left: string, right: string): boolean {
  const a = left.replace(/\D/g, '')
  const b = right.replace(/\D/g, '')
  return a === b || (a.length === 12 && b === '0' + a) || (b.length === 12 && a === '0' + b)
}

function normalizeWords(value: string): string[] {
  return value.toLocaleLowerCase('de-DE')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word === 'pkm' ? 'pokemon' : word === 'premi' ? 'premium' : word)
}

function wordsMatch(left: string, right: string): boolean {
  if (left === right) return true
  if (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left))) return true
  if (Math.min(left.length, right.length) < 5 || Math.abs(left.length - right.length) > 1) return false
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length] <= 1
}

/** Conservative token similarity: reject vague or unrelated catalog results. */
export function productNameSimilarity(receiptName: string, catalogName: string): number {
  const query = normalizeWords(receiptName).filter(word => !['the', 'and', 'der', 'die', 'das'].includes(word))
  const result = normalizeWords(catalogName).filter(word => !['the', 'and', 'der', 'die', 'das'].includes(word))
  if (!query.length || !result.length) return 0
  const used = new Set<number>()
  let matched = 0
  for (const word of query) {
    const index = result.findIndex((other, itemIndex) => !used.has(itemIndex) && wordsMatch(word, other))
    if (index >= 0) {
      used.add(index)
      matched++
    }
  }
  const coverage = matched / query.length
  const jaccard = matched / Math.max(1, query.length + result.length - matched)
  return Math.round((coverage * 0.72 + jaccard * 0.28) * 1000) / 1000
}

async function requestCatalog(path: string): Promise<CatalogItem[]> {
  if (!await reserveFreeApiRequest(path.includes('/search?'))) throw new Error('Free product catalog request budget reached')
  const response = await fetch(path, { headers: { Accept: 'application/json' } })
  if (response.status === 404) return []
  if (!response.ok) throw new Error('Product catalog request failed: ' + response.status)
  const data = await response.json() as CatalogResponse
  return Array.isArray(data.items)
    ? data.items.filter(item => typeof item.title === 'string' && item.title.trim())
    : []
}

async function lookupBarcodes(barcodes: string[]): Promise<Map<string, CatalogItem>> {
  const found = new Map<string, CatalogItem>()
  const missing: string[] = []
  for (const code of [...new Set(barcodes)].slice(0, 2)) {
    const curated = Object.entries(VERIFIED_BARCODE_CATALOG)
      .find(([barcode]) => equivalentBarcode(code, barcode))?.[1]
    if (curated) {
      found.set(code, curated)
      continue
    }
    const cached = readCache('ean:' + code)
    if (cached) {
      const item = cached.find(candidate =>
        [candidate.ean, candidate.upc, candidate.gtin].some(value => value && equivalentBarcode(code, value))
      )
      if (item) found.set(code, item)
    } else {
      missing.push(code)
    }
  }
  if (missing.length) {
    try {
      const query = encodeURIComponent(missing.join(','))
      const items = await requestCatalog('/api/product/lookup?barcodes=' + query)
      for (const code of missing) {
        const matches = items.filter(item =>
          [item.ean, item.upc, item.gtin].some(value => value && equivalentBarcode(code, value))
        )
        writeCache('ean:' + code, matches, matches.length ? CACHE_TTL : SEARCH_TTL)
        if (matches[0]) found.set(code, matches[0])
      }
    } catch {
      // Product identification remains local and editable when the catalog is unavailable.
    }
  }
  return found
}

async function searchByName(name: string): Promise<CatalogItem[]> {
  const cacheKey = 'search:' + normalizeWords(name).join(' ')
  const cached = readCache(cacheKey)
  if (cached) return cached
  try {
    const items = await requestCatalog('/api/product/search?q=' + encodeURIComponent(name.slice(0, 100)))
    writeCache(cacheKey, items, SEARCH_TTL)
    return items
  } catch {
    return []
  }
}

/**
 * Exact barcode matches take priority; text search is only a cautious fallback.
 * The free external API is called only when a local cache misses.
 */
export async function enrichInvoiceProductNames(lines: InvoiceLineItem[]): Promise<InvoiceLineItem[]> {
  if (!lines.length) return lines
  const codes = lines.map(line => line.barcode).filter((value): value is string => Boolean(value))
  const barcodeMatches = codes.length ? await lookupBarcodes(codes) : new Map<string, CatalogItem>()
  let enriched = lines.map(line => {
    if (!line.barcode) return line
    const item = barcodeMatches.get(line.barcode)
    if (!item?.title) return { ...line, confidence: Math.min(line.confidence, 0.69) }
    return { ...line, description: item.title.trim(), confidence: 0.99, productVerified: true, productVerification: 'barcode' as const }
  })
  // Do not spend a second trial API request on a receipt that already had a barcode.
  // A labelled but unresolved barcode remains unverified and is sent to manual review.
  if (codes.length || enriched.some(line => line.productVerified)) return enriched

  // One text query per receipt at most; a strict similarity threshold rejects unrelated hits.
  const candidateIndex = enriched.findIndex(line => line.description.trim().length >= 5 && line.confidence >= 0.55)
  if (candidateIndex < 0) return enriched
  const candidates = await searchByName(enriched[candidateIndex].description)
  const ranked = candidates
    .map(item => ({ item, score: productNameSimilarity(enriched[candidateIndex].description, item.title || '') }))
    .filter(match => match.score >= 0.68)
    .sort((a, b) => b.score - a.score)
  if (!ranked.length) return enriched
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < 0.035 &&
      ranked[0].item.title !== ranked[1].item.title) return enriched
  enriched = enriched.map((line, index) => index === candidateIndex
    ? { ...line, description: ranked[0].item.title!.trim(), confidence: Math.max(line.confidence, 0.84), productVerified: true, productVerification: 'name' as const }
    : line)
  return enriched
}
