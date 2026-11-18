export type ShippingDirection = 'incoming' | 'outgoing'

export type GmailTrackingCandidate = {
  id: string
  messageId: string
  subject: string
  sender: string
  date: string
  direction: ShippingDirection
  carrier: string
  trackingNumber: string
  trackingUrl: string
  snippet: string
  suggestedProductId: string
  matchConfidence: number
}

export type MatchableProduct = {
  id: string
  name: string
  purchaseDate?: string
  saleDate?: string
  status?: string
}

type GmailMessageRef = { id: string; threadId?: string }
type GmailHeader = { name?: string; value?: string }
type GmailPart = {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}
type GmailMessage = {
  id?: string
  snippet?: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailPart & { headers?: GmailHeader[] }
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TRACKING_TERMS = /tracking|track(?:ing)?|sendungsverfolg|sendungsnummer|paketnummer|shipment|parcel|delivery|lieferung|versand|versendet|shipped|dispatched|zugestellt/i
const CARRIER_HOSTS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'DHL', pattern: /(^|\.)dhl\./i },
  { name: 'Deutsche Post', pattern: /(^|\.)deutschepost\.de$/i },
  { name: 'DPD', pattern: /(^|\.)dpd\./i },
  { name: 'Hermes', pattern: /(^|\.)(myhermes\.de|hermesworld\.com|hermes\.[a-z.]+)$/i },
  { name: 'GLS', pattern: /(^|\.)gls(-group)?\./i },
  { name: 'UPS', pattern: /(^|\.)ups\./i },
  { name: 'FedEx', pattern: /(^|\.)fedex\./i },
  { name: 'Amazon Logistics', pattern: /(^|\.)amazon\.[a-z.]+$/i },
  { name: 'InPost', pattern: /(^|\.)inpost\./i },
  { name: 'PostNL', pattern: /(^|\.)postnl\./i },
  { name: 'DPDgroup', pattern: /(^|\.)chrono-post\./i },
]

function normalizeText(value: string): string {
  return value.toLocaleLowerCase('de-DE')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function identifyCarrier(urlOrHost: string): string {
  let host = urlOrHost
  try {
    host = new URL(urlOrHost).hostname
  } catch {
    host = urlOrHost.replace(/^www\./i, '')
  }
  return CARRIER_HOSTS.find(item => item.pattern.test(host))?.name || ''
}

export function isSafeTrackingUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) return false
    if (/^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) return false
    return Boolean(identifyCarrier(url.hostname) || TRACKING_TERMS.test(url.pathname + url.search))
  } catch {
    return false
  }
}

function unwrapTrackingUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    if (/^(?:www\.)?(?:google\.com|googleusercontent\.com)$/i.test(url.hostname)) {
      const nested = url.searchParams.get('url') || url.searchParams.get('q') || url.searchParams.get('u')
      if (nested && /^https:\/\//i.test(nested)) return nested
    }
    return url.toString()
  } catch {
    return rawUrl
  }
}

export function scoreProductMatch(productName: string, emailText: string): number {
  const productTokens = [...new Set(normalizeText(productName).split(' ').filter(token =>
    token.length >= 3 && !['the', 'and', 'mit', 'von', 'der', 'die', 'das', 'für', 'fur', 'und'].includes(token)
  ))]
  if (!productTokens.length) return 0
  const email = ' ' + normalizeText(emailText) + ' '
  const matched = productTokens.filter(token => email.includes(' ' + token + ' '))
  if (matched.length === 0) return 0
  const coverage = matched.length / productTokens.length
  // A single common word is not enough to auto-assign a shipment.
  if (matched.length === 1) return Math.min(0.54, coverage * 0.54)
  return Math.min(0.96, 0.58 + coverage * 0.38 + (matched.length >= 3 ? 0.04 : 0))
}

export function suggestProductMatch(
  products: MatchableProduct[],
  emailText: string,
): { productId: string; confidence: number } {
  const ranked = products.map(product => ({
    id: product.id,
    confidence: scoreProductMatch(product.name, emailText),
  })).sort((a, b) => b.confidence - a.confidence)
  const best = ranked[0]
  const second = ranked[1]
  if (!best || best.confidence < 0.78) {
    return { productId: '', confidence: best?.confidence || 0 }
  }
  // Similar product names or identical units must never be auto-assigned.
  if (second && best.confidence - second.confidence < 0.12) {
    return { productId: '', confidence: best.confidence }
  }
  return { productId: best.id, confidence: best.confidence }
}

function decodeBase64Url(value: string): string {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

function collectBodies(part: GmailPart | undefined, output: { text: string[]; html: string[] }): void {
  if (!part) return
  if (part.body?.data) {
    const decoded = decodeBase64Url(part.body.data)
    if (part.mimeType === 'text/plain') output.text.push(decoded)
    if (part.mimeType === 'text/html') output.html.push(decoded)
  }
  for (const child of part.parts || []) collectBodies(child, output)
}

function extractLinks(html: string, text: string): Array<{ url: string; label: string }> {
  const links: Array<{ url: string; label: string }> = []
  if (html && typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(html, 'text/html')
    document.querySelectorAll('a[href]').forEach(anchor => {
      links.push({
        url: (anchor.getAttribute('href') || '').trim(),
        label: (anchor.textContent || '').trim(),
      })
    })
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    links.push({ url: match[0].replace(/[),.;!?]+$/g, ''), label: '' })
  }
  return links
}

function extractTrackingNumber(text: string): string {
  const labeled = text.match(/(?:sendungsnummer|paketnummer|tracking(?:nummer|\s*(?:number|id))?|shipment\s*(?:number|id)|parcel\s*(?:number|id))\s*(?:ist|is|lautet|[:#-])?\s*([A-Z0-9][A-Z0-9 -]{7,34})/i)
  if (!labeled) return ''
  const value = labeled[1].split(/\r?\n/)[0].trim().replace(/[.,;:]+$/g, '')
  const compact = value.replace(/[ -]/g, '')
  if (compact.length < 8 || compact.length > 35 || !/[0-9]/.test(compact)) return ''
  return compact
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find(header => header.name?.toLowerCase() === name.toLowerCase())?.value || ''
}

function dateFromMessage(message: GmailMessage): string {
  const milliseconds = Number(message.internalDate || 0)
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? new Date(milliseconds).toISOString()
    : ''
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  })
  if (!response.ok) {
    if (response.status === 401) throw new Error('Die Gmail-Berechtigung ist abgelaufen. Verbinde Gmail erneut.')
    if (response.status === 403) throw new Error('Google hat den Gmail-Zugriff abgelehnt. Prüfe, ob die Gmail API aktiviert ist und die Leseberechtigung erteilt wurde.')
    throw new Error('Gmail konnte die Nachricht nicht abrufen (HTTP ' + response.status + ').')
  }
  return response.json() as Promise<T>
}

function parseMessage(message: GmailMessage, products: MatchableProduct[]): GmailTrackingCandidate[] {
  const payload = message.payload
  const bodies = { text: [] as string[], html: [] as string[] }
  collectBodies(payload, bodies)
  const headers = payload?.headers
  const subject = headerValue(headers, 'subject')
  const sender = headerValue(headers, 'from')
  const combinedText = [subject, ...bodies.text].join('\n')
  const htmlText = bodies.html.map(html => {
    if (typeof DOMParser === 'undefined') return html.replace(/<[^>]*>/g, ' ')
    return new DOMParser().parseFromString(html, 'text/html').body?.textContent || ''
  }).join('\n')
  const searchableText = [combinedText, htmlText, message.snippet || ''].join('\n')
  const links = extractLinks(bodies.html.join('\n'), [combinedText, htmlText].join('\n'))
  const validLinks = links.map(link => {
    const url = unwrapTrackingUrl(link.url)
    return { url, label: link.label, carrier: identifyCarrier(url) }
  }).filter(link => isSafeTrackingUrl(link.url) &&
    (link.carrier || TRACKING_TERMS.test(link.label + ' ' + link.url)))

  const uniqueLinks = [...new Map(validLinks.map(link => [link.url, link])).values()].slice(0, 8)
  if (uniqueLinks.length === 0) return []
  const trackingNumber = extractTrackingNumber(searchableText)
  const date = dateFromMessage(message)
  const direction: ShippingDirection = message.labelIds?.includes('SENT') ? 'outgoing' : 'incoming'
  const searchable = [subject, sender, searchableText, ...uniqueLinks.map(link => link.url)].join(' ')
  const match = suggestProductMatch(products, searchable)
  const suggestedProductId = match.productId
  const matchConfidence = match.confidence

  return uniqueLinks.map((link, index) => ({
    id: (message.id || 'mail') + ':' + index,
    messageId: message.id || '',
    subject: subject || '(ohne Betreff)',
    sender,
    date,
    direction,
    carrier: link.carrier || 'Versanddienst',
    trackingNumber,
    trackingUrl: link.url,
    snippet: (message.snippet || '').slice(0, 220),
    suggestedProductId,
    matchConfidence,
  }))
}

/**
 * Reads only Gmail messages that look like shipping updates. Message bodies are
 * processed locally in the browser and are never forwarded to an AI provider.
 */
export async function scanGmailForTracking(
  accessToken: string,
  products: MatchableProduct[],
  days = 180,
  maxResults = 100,
): Promise<GmailTrackingCandidate[]> {
  if (!accessToken) throw new Error('Es fehlt eine gültige Gmail-Freigabe.')
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)))
  const query = 'newer_than:' + safeDays + 'd {tracking track shipment shipped dispatched Versand versendet Sendungsverfolgung Sendungsnummer}'
  const listUrl = new URL(GMAIL_API + '/messages')
  listUrl.searchParams.set('q', query)
  listUrl.searchParams.set('maxResults', String(Math.max(1, Math.min(100, maxResults))))
  const list = await getJson<{ messages?: GmailMessageRef[] }>(listUrl.toString(), accessToken)
  const refs = list.messages || []
  const messages: GmailMessage[] = []
  for (let index = 0; index < refs.length; index += 5) {
    const batch = refs.slice(index, index + 5)
    const fetched = await Promise.all(batch.map(ref => {
      const url = new URL(GMAIL_API + '/messages/' + encodeURIComponent(ref.id))
      url.searchParams.set('format', 'full')
      return getJson<GmailMessage>(url.toString(), accessToken)
    }))
    messages.push(...fetched)
  }
  return messages.flatMap(message => parseMessage(message, products))
    .sort((a, b) => b.date.localeCompare(a.date))
}
