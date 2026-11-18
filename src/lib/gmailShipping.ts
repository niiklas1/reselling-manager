export type ShippingDirection = 'incoming' | 'outgoing'

export type GmailTrackingCandidate = {
  id: string
  messageId: string
  threadId: string
  subject: string
  sender: string
  senderDomain: string
  date: string
  direction: ShippingDirection
  carrier: string
  trackingNumber: string
  trackingUrl: string
  snippet: string
  matchText: string
  suggestedProductId: string
  matchConfidence: number
  matchReason?: string
  matchSource?: string
}

export type MatchableProduct = {
  id: string
  name: string
  category?: string
  platform?: string
  purchaseDate?: string
  saleDate?: string
  status?: string
  incomingTrackingUrl?: string
  outgoingTrackingUrl?: string
}

export type AiProductMatch = {
  candidateId: string
  productId: string
  score: number
  semanticScore: number
  lexicalScore: number
  rerankerScore?: number
  modelAgreement?: boolean
  reason?: string
}

export type GmailLearningHint = {
  senderDomain: string
  productId: string
  direction: ShippingDirection
  subjectTokens: string[]
  approvedAt: string
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
  threadId?: string
  snippet?: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailPart & { headers?: GmailHeader[] }
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const SHIPPING_INTENT = /\b(?:shipping confirmation|shipment confirmation|shipment update|your order has shipped|your order was shipped|your package has shipped|your parcel has shipped|we(?:'|’)ve shipped|we have shipped|shipped your order|is on its way|on its way to you|out for delivery|in transit|left our warehouse|left the warehouse|dispatch confirmation|dispatched your order|has been dispatched|handed to carrier|handed to courier|carrier picked up|carrier has your package|delivery attempt|arriving today|ready for pickup|available for pickup|Versandmitteilung|Paket wurde abgeholt|versandfertig|tracking number|tracking details|track your (?:order|package|parcel)|track package|sendungsverfolgung|sendungsnummer|versandbest(?:ä|ae)tigung|wurde versendet|wurde verschickt|ist unterwegs|auf dem weg zu dir|paket wurde versendet|paket wurde verschickt|ihre bestellung wurde versendet|ihre sendung wurde|in zustellung|zustellversuch|abholbereit)\b/i
const TRACKING_LABEL = /\b(?:track(?:ing)? (?:your )?(?:order|package|parcel|shipment)|sendungsverfolgung|tracking (?:link|number|details|information)|view tracking|track shipment|track package|track parcel)\b/i
const TRACKING_ENDPOINT = /(?:^|[\/_.-])(?:track(?:ing)?|shiptrack|shipment-tracking|parcel-tracking|package-tracking|sendungsverfolgung|progress-tracker)(?:$|[\/_.?&=-])/i
const TRACKING_ID_PARAMS = new Set(['tracking', 'trackingnumber', 'tracking_number', 'trackingid', 'tracking_id', 'trackingcode', 'tracking_code', 'trackno', 'track_no', 'tracknum', 'track_num', 'trackid', 'track_id', 'shipmentid', 'shipment_id', 'shipmentnumber', 'shipment_number', 'shipmentno', 'shipment_no', 'parcelid', 'parcel_id', 'parcelnumber', 'parcel_number', 'packageid', 'package_id', 'consignment', 'consignmentnumber', 'consignment_number', 'waybill', 'waybillnumber', 'awb', 'awbnumber', 'barcode', 'code'])
const TRACKING_TERMS = /tracking|track|sendungsverfolg|sendungsnummer|paketnummer|shipment|parcel/i

export function isLikelyShippingEmail(subject: string, bodyText: string): boolean {
  return SHIPPING_INTENT.test(subject + '\n' + bodyText)
}
const CARRIERS: Array<{ name: string; domains: string[] }> = [
  { name: 'DHL', domains: ['dhl.de', 'dhl.com', 'dhl.co.uk', 'dhl.fr', 'dhl.nl', 'dhl.at', 'dhl.ch', 'dhlparcel.nl'] },
  { name: 'Deutsche Post', domains: ['deutschepost.de', 'deutschepost.com'] },
  { name: 'DPD', domains: ['dpd.de', 'dpd.com', 'dpd.co.uk', 'dpd.fr', 'dpd.nl', 'dpdgroup.com'] },
  { name: 'Hermes', domains: ['myhermes.de', 'hermesworld.com', 'hermes.de', 'evri.com'] },
  { name: 'GLS', domains: ['gls-group.com', 'gls-group.eu', 'gls-pakete.de', 'gls.de', 'gls-italy.com', 'gls-netherlands.com'] },
  { name: 'UPS', domains: ['ups.com', 'ups.de', 'ups.co.uk'] },
  { name: 'FedEx', domains: ['fedex.com', 'fedex.de', 'fedex.co.uk'] },
  { name: 'Amazon Logistics', domains: ['amazon.de', 'amazon.com', 'amazon.co.uk', 'amazon.fr', 'amazon.it', 'amazon.es'] },
  { name: 'InPost', domains: ['inpost.pl', 'inpost.eu', 'inpost.co.uk'] },
  { name: 'PostNL', domains: ['postnl.nl', 'postnl.be'] },
  { name: 'Chronopost', domains: ['chronopost.fr'] },
  { name: 'Royal Mail', domains: ['royalmail.com'] },
  { name: 'USPS', domains: ['usps.com'] },
  { name: 'La Poste', domains: ['laposte.fr'] },
  { name: 'Canada Post', domains: ['canadapost.ca', 'canadapost-postescanada.ca'] },
  { name: 'Australia Post', domains: ['auspost.com.au'] },
  { name: 'Swiss Post', domains: ['post.ch'] },
  { name: 'Österreichische Post', domains: ['post.at'] },
  { name: 'Correos', domains: ['correos.es'] },
  { name: 'Poste Italiane', domains: ['poste.it'] },
  { name: 'Mondial Relay', domains: ['mondialrelay.fr', 'mondialrelay.be', 'mondialrelay.nl'] },
  { name: 'Yodel', domains: ['yodel.co.uk'] },
  { name: 'Cainiao', domains: ['global.cainiao.com', 'cainiao.com'] },
  { name: 'YunExpress', domains: ['yunexpress.com'] },
  { name: '4PX', domains: ['4px.com'] },
  { name: 'Asendia', domains: ['asendia.com'] },
  { name: 'Aramex', domains: ['aramex.com'] },
  { name: 'SF Express', domains: ['sf-express.com'] },
  { name: 'PostNord', domains: ['postnord.com', 'postnord.se', 'postnord.dk'] },
  { name: 'An Post', domains: ['anpost.com'] },
  { name: 'Parcelforce', domains: ['parcelforce.com'] },
  { name: 'bpost', domains: ['bpost.be'] },
]

function normalizeText(value: string): string {
  return value.toLocaleLowerCase('de-DE')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function identifyCarrier(urlOrHost: string): string {
  let host = urlOrHost.toLowerCase()
  try {
    host = new URL(urlOrHost).hostname.toLowerCase()
  } catch {
    host = host.replace(/^www\./i, '')
  }
  return CARRIERS.find(carrier => carrier.domains.some(domain =>
    host === domain || host.endsWith('.' + domain)
  ))?.name || ''
}

function hasTrackingEndpoint(url: URL): boolean {
  let path = url.pathname
  try { path = decodeURIComponent(url.pathname) } catch { /* retain the encoded pathname */ }
  if (TRACKING_ENDPOINT.test(path)) return true
  for (const [key, value] of url.searchParams.entries()) {
    if (TRACKING_ID_PARAMS.has(key.toLowerCase()) && value.trim().length >= 5) return true
  }
  return false
}

function resemblesCarrierSpoof(hostname: string): boolean {
  if (identifyCarrier(hostname)) return false
  const labels = hostname.toLowerCase().split('.')
  const brands = ['dhl', 'dpd', 'hermes', 'evri', 'gls', 'ups', 'fedex', 'inpost', 'postnl', 'chronopost', 'royalmail', 'usps', 'laposte', 'canadapost', 'auspost', 'correos', 'poste', 'mondialrelay', 'yodel', 'cainiao', 'yunexpress', '4px', 'asendia', 'aramex', 'sfexpress', 'postnord', 'anpost', 'parcelforce', 'bpost']
  return labels.some(label => brands.some(brand => label === brand || label.startsWith(brand + '-') || label.endsWith('-' + brand)))
}

export function isSafeTrackingUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    if (!host || host === 'localhost' || host.endsWith('.local') || host.startsWith('[')) return false
    if (/^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return false
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false
    if (!hasTrackingEndpoint(url)) return false
    return !resemblesCarrierSpoof(host)
  } catch {
    return false
  }
}

function resemblesUnsafeTrackingHost(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || !host || host === 'localhost' || host.endsWith('.local') || host.startsWith('[')) return true
    if (/^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true
    return resemblesCarrierSpoof(host)
  } catch {
    return true
  }
}

function unwrapTrackingUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const wrapperHosts = /^(?:www\.)?google\.(?:com|de|co\.uk)$/i
    const redirectKeys = ['url', 'u', 'redirect', 'redirect_url', 'target', 'destination', 'dest', 'to', 'link', 'continue']
    const nested = wrapperHosts.test(url.hostname)
      ? url.searchParams.get('url') || url.searchParams.get('q') || url.searchParams.get('u')
      : redirectKeys.map(key => url.searchParams.get(key)).find(value => value && /^https:\/\//i.test(value)) || ''
    if (nested && /^https:\/\//i.test(nested)) {
      try {
        const nestedUrl = new URL(nested)
        if (isSafeTrackingUrl(nestedUrl.toString())) return nestedUrl.toString()
      } catch { /* keep the original HTTPS redirect if parsing fails */ }
    }
    return url.toString()
  } catch {
    return rawUrl
  }
}

function productTokens(value: string): string[] {
  const ignored = new Set([
    'the', 'and', 'mit', 'von', 'der', 'die', 'das', 'fur', 'fuer', 'und',
    'order', 'your', 'have', 'has', 'been', 'shipped', 'shipping', 'track',
    'tracking', 'number', 'package', 'parcel', 'shipment', 'delivery', 'sent',
    'versand', 'bestellung', 'sendung', 'paket', 'wurden', 'wurde', 'ist',
    'eine', 'einer', 'eines', 'bei', 'aus', 'the', 'for', 'with', 'this',
    'box', 'edition', 'limited', 'trainer', 'elite', 'collection', 'official',
  ])
  return [...new Set(normalizeText(value).split(' ').filter(token =>
    (token.length >= 3 || /^\d{4,}$/.test(token)) && !ignored.has(token)
  ))]
}

export function scoreProductMatch(productName: string, emailText: string): number {
  const tokens = productTokens(productName)
  if (!tokens.length) return 0
  const email = ' ' + normalizeText(emailText) + ' '
  const matched = tokens.filter(token => email.includes(' ' + token + ' '))
  if (matched.length === 0) return 0
  if (matched.length === tokens.length) return 0.98
  if (matched.length === 1) return Math.min(0.56, 0.42 + (matched[0].length >= 7 ? 0.12 : 0.05))
  const coverage = matched.length / tokens.length
  return Math.min(0.95, 0.56 + coverage * 0.43 + (matched.length >= 3 ? 0.03 : 0))
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

function htmlToText(html: string): string {
  if (!html) return ''
  if (typeof DOMParser === 'undefined') return html.replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]*>/g, ' ')
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script,style,head,svg,noscript').forEach(node => node.remove())
  return document.body?.textContent || ''
}

function extractLinks(html: string, text: string): Array<{ url: string; label: string; context: string }> {
  const links: Array<{ url: string; label: string; context: string }> = []
  if (html && typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(html, 'text/html')
    document.querySelectorAll('a[href]').forEach(anchor => {
      const label = (anchor.textContent || '').trim()
      const context = (anchor.parentElement?.textContent || '').trim().slice(0, 450)
      links.push({ url: (anchor.getAttribute('href') || '').trim(), label, context })
    })
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    links.push({ url: match[0].replace(/[),.;!?]+$/g, ''), label: '', context: '' })
  }
  return links
}

function extractTrackingNumber(text: string): string {
  const labeled = text.match(/(?:sendungsnummer|paketnummer|tracking(?:nummer|\s*(?:number|id))?|shipment\s*(?:number|id)|parcel\s*(?:number|id)|tracking\s*#)\s*(?:ist|is|lautet|[:#-])?\s*([A-Z0-9][A-Z0-9 -]{7,34})/i)
  if (!labeled) return ''
  const value = labeled[1].split(/\r?\n/)[0].trim().replace(/[.,;:]+$/g, '')
  const compact = value.replace(/[ -]/g, '')
  if (compact.length < 8 || compact.length > 35 || !/[0-9]/.test(compact)) return ''
  return compact
}

function trackingNumberFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    for (const [key, value] of url.searchParams.entries()) {
      if (TRACKING_ID_PARAMS.has(key.toLowerCase())) {
        const compact = value.replace(/[^A-Z0-9]/gi, '')
        if (compact.length >= 8 && compact.length <= 35 && /\d/.test(compact)) return compact
      }
    }
    const pathMatch = url.pathname.match(/(?:track|tracking|shipment|parcel|package)[/=_-]([A-Z0-9-]{8,35})(?:\/|$)/i)
    return pathMatch ? pathMatch[1].replace(/-/g, '') : ''
  } catch {
    return ''
  }
}

export function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset: string, encoding: string, payload: string) => {
    try {
      if (encoding.toLowerCase() === 'b') {
        const binary = atob(payload)
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
        return new TextDecoder(charset || 'utf-8').decode(bytes)
      }
      const decoded = payload.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, '%$1')
      return decodeURIComponent(decoded)
    } catch {
      return whole
    }
  })
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const value = headers?.find(header => header.name?.toLowerCase() === name.toLowerCase())?.value || ''
  return decodeMimeWords(value)
}

function senderDomain(sender: string): string {
  const address = sender.match(/<([^>]+)>/)?.[1] || sender
  const domain = address.match(/@([a-z0-9.-]+\.[a-z]{2,})/i)?.[1]
  return domain?.toLowerCase().replace(/^www\./, '') || ''
}

function dateFromMessage(message: GmailMessage): string {
  const milliseconds = Number(message.internalDate || 0)
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : ''
}

function canonicalTrackingUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|mc_[ce]id$)/i.test(key)) url.searchParams.delete(key)
    }
    url.hostname = url.hostname.toLowerCase()
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.searchParams.sort()
    return url.toString()
  } catch {
    return rawUrl
  }
}

export function trackingCandidateDedupKey(candidate: Pick<GmailTrackingCandidate, 'trackingNumber' | 'trackingUrl' | 'messageId'>): string {
  if (candidate.trackingNumber) return 'number:' + candidate.trackingNumber.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (candidate.trackingUrl) return 'url:' + canonicalTrackingUrl(candidate.trackingUrl)
  return 'message:' + candidate.messageId
}

function minimizeForAi(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[E-Mail entfernt]')
    .replace(/\b(?:tel(?:efon)?|phone|mobile|mobil)\s*[:#]?\s*[\d+() .-]{6,}/gi, '[Telefon entfernt]')
    .replace(/\b(?:lieferadresse|shipping address|delivery address|billing address|rechnungsadresse)\b[\s\S]{0,180}/gi, '[Adressdaten entfernt]')
    .replace(/\b\d{5}\s+[A-ZÄÖÜ][^\n]{0,70}/g, '[Adressdaten entfernt]')
    .replace(/https?:\/\/\S+/gi, '[Link]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1400)
}

function parseMessage(message: GmailMessage, products: MatchableProduct[]): GmailTrackingCandidate[] {
  const labels = message.labelIds || []
  if (labels.some(label => ['SPAM', 'TRASH', 'CATEGORY_SOCIAL'].includes(label))) return []
  const payload = message.payload
  const bodies = { text: [] as string[], html: [] as string[] }
  collectBodies(payload, bodies)
  const headers = payload?.headers
  const subject = headerValue(headers, 'subject')
  const sender = headerValue(headers, 'from')
  const domain = senderDomain(sender)
  const plainText = [subject, ...bodies.text].join('\n')
  const htmlText = bodies.html.map(htmlToText).join('\n')
  const searchableText = [plainText, htmlText, message.snippet || ''].join('\n')
  const links = extractLinks(bodies.html.join('\n'), [plainText, htmlText, message.snippet || ''].join('\n'))
  const trackingNumber = extractTrackingNumber(searchableText)
  const hasShippingIntent = isLikelyShippingEmail(subject, searchableText)
  if (!hasShippingIntent && !trackingNumber) return []

  const validLinks = links.map(link => {
    const url = unwrapTrackingUrl(link.url)
    let parsed: URL | null = null
    try { parsed = new URL(url) } catch { /* ignored */ }
    const linkText = link.label + ' ' + link.context
    const labelledTrackingAction = TRACKING_LABEL.test(linkText)
    const carrier = parsed ? identifyCarrier(parsed.hostname) : ''
    const urlTrackingNumber = trackingNumberFromUrl(url)
    const endpoint = Boolean(parsed && hasTrackingEndpoint(parsed))
    const pathIsUseful = Boolean(parsed && parsed.pathname !== '/' && parsed.pathname.length > 2)
    // Retailers sometimes place tracking behind an order-status button rather
    // than a URL containing the word "tracking". Admit this only in a clearly
    // identified shipping email and only for a specific non-homepage path.
    const shipmentContextLink = hasShippingIntent && labelledTrackingAction && pathIsUseful
    const carrierWithNumber = Boolean(carrier && (urlTrackingNumber || trackingNumber) && pathIsUseful)
    const score = (labelledTrackingAction ? 6 : 0) +
      (endpoint ? 5 : 0) +
      (carrier ? 3 : 0) +
      (shipmentContextLink ? 2 : 0) +
      (carrierWithNumber ? 2 : 0)
    return {
      url,
      label: link.label,
      context: link.context,
      carrier,
      trackingNumber: urlTrackingNumber,
      score,
      isCandidate: endpoint || labelledTrackingAction || carrierWithNumber,
    }
  }).filter(link =>
    (isSafeTrackingUrl(link.url) || (hasShippingIntent && link.isCandidate && !resemblesUnsafeTrackingHost(link.url))) &&
    link.score >= 5 &&
    (Boolean(link.trackingNumber || trackingNumber) || TRACKING_LABEL.test(link.label + ' ' + link.context))
  )

  const isBulk = Boolean(headerValue(headers, 'list-unsubscribe') || headerValue(headers, 'list-id')) ||
    /^(?:bulk|list)/i.test(headerValue(headers, 'precedence'))
  const isPromotion = labels.includes('CATEGORY_PROMOTIONS')
  if ((isBulk || isPromotion) && !trackingNumber && !validLinks.some(link => link.trackingNumber)) return []

  const uniqueLinks = [...new Map(validLinks
    .sort((a, b) => b.score - a.score)
    .map(link => [canonicalTrackingUrl(link.url), link])).values()].slice(0, 3)
  const date = dateFromMessage(message)
  const direction: ShippingDirection = labels.includes('SENT') ? 'outgoing' : 'incoming'
  const matchText = [subject, searchableText, domain].join('\n').slice(0, 5000)
  const match = suggestProductMatch(products, searchableText)
  const inferredCarrier = identifyCarrier(domain) || CARRIERS.find(carrier =>
    normalizeText(searchableText + ' ' + sender).includes(normalizeText(carrier.name))
  )?.name || 'Versanddienst'

  if (!uniqueLinks.length) {
    // Preserve explicitly labelled parcel numbers even when the carrier email
    // omitted a direct tracking URL. Never invent a tracking destination.
    if (!trackingNumber) return []
    return [{
      id: (message.id || 'mail') + ':number',
      messageId: message.id || '',
      threadId: message.threadId || '',
      subject: subject || '(ohne Betreff)',
      sender,
      senderDomain: domain,
      date,
      direction,
      carrier: inferredCarrier,
      trackingNumber,
      trackingUrl: '',
      snippet: (message.snippet || '').slice(0, 220),
      matchText: minimizeForAi(matchText),
      suggestedProductId: match.productId,
      matchConfidence: match.confidence,
    }]
  }

  return uniqueLinks.map((link, index) => ({
    id: (message.id || 'mail') + ':' + index,
    messageId: message.id || '',
    threadId: message.threadId || '',
    subject: subject || '(ohne Betreff)',
    sender,
    senderDomain: domain,
    date,
    direction,
    carrier: link.carrier || inferredCarrier,
    trackingNumber: link.trackingNumber || trackingNumber,
    trackingUrl: link.url,
    snippet: (message.snippet || '').slice(0, 220),
    matchText: minimizeForAi(matchText),
    suggestedProductId: match.productId,
    matchConfidence: match.confidence,
  }))
}

async function getJson<T>(url: string, token: string): Promise<T> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Netzwerkfehler beim Gmail-Zugriff.')
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
        continue
      }
      throw lastError
    }
    if (response.ok) return response.json() as Promise<T>
    if (response.status === 401) throw new Error('Die Gmail-Berechtigung ist abgelaufen. Verbinde Gmail erneut.')
    if (response.status === 403) throw new Error('Google hat den Gmail-Zugriff abgelehnt. Prüfe, ob die Gmail API aktiviert ist und die Leseberechtigung erteilt wurde.')
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
      throw new Error('Gmail konnte die Nachricht nicht abrufen (HTTP ' + response.status + ').')
    }
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
  }
  throw lastError || new Error('Gmail konnte die Nachricht nicht abrufen.')
}

/**
 * Finds actual parcel-dispatch notifications, not merely emails containing a
 * generic "delivery" link. Gmail messages are parsed locally in the browser.
 */
export async function scanGmailForTracking(
  accessToken: string,
  products: MatchableProduct[],
  days = 180,
  maxResults = 250,
): Promise<GmailTrackingCandidate[]> {
  if (!accessToken) throw new Error('Es fehlt eine gültige Gmail-Freigabe.')
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)))
  const safeMax = Math.max(1, Math.min(300, Math.floor(maxResults)))
  const queries = [
    'newer_than:' + safeDays + 'd { "has shipped" shipped dispatch tracking "track your order" "track your package" shipment parcel "shipping confirmation" "on its way" versendet verschickt versandbestätigung sendungsnummer sendungsverfolgung unterwegs } -category:social -in:spam -in:trash',
    'newer_than:' + safeDays + 'd { "handed to carrier" "carrier picked up" "left the warehouse" "left our warehouse" "delivery attempt" "ready for pickup" "available for pickup" "arriving today" "your parcel is moving" "Versandmitteilung" "Paket wurde abgeholt" "versandfertig" "an den Versanddienstleister übergeben" } -category:social -in:spam -in:trash',
  ]
  const refsById = new Map<string, GmailMessageRef>()
  // Preserve the original query and add a supplemental search for handover,
  // pickup and last-mile messages. The parser still validates every candidate.
  for (const [queryIndex, query] of queries.entries()) {
    const queryLimit = queryIndex === 0 ? safeMax : Math.min(120, safeMax)
    let pageToken = ''
    let queryCount = 0
    do {
      const listUrl = new URL(GMAIL_API + '/messages')
      listUrl.searchParams.set('q', query)
      listUrl.searchParams.set('maxResults', String(Math.min(100, queryLimit - queryCount)))
      if (pageToken) listUrl.searchParams.set('pageToken', pageToken)
      const list = await getJson<{ messages?: GmailMessageRef[]; nextPageToken?: string }>(listUrl.toString(), accessToken)
      for (const ref of list.messages || []) refsById.set(ref.id, ref)
      queryCount += (list.messages || []).length
      pageToken = list.nextPageToken || ''
    } while (pageToken && queryCount < queryLimit)
  }
  const refs = [...refsById.values()]

  const uniqueRefs = [...new Map(refs.map(ref => [ref.id, ref])).values()]
  const messages: GmailMessage[] = []
  for (let index = 0; index < uniqueRefs.length; index += 6) {
    const batch = uniqueRefs.slice(index, index + 6)
    const fetched = await Promise.allSettled(batch.map(ref => {
      const url = new URL(GMAIL_API + '/messages/' + encodeURIComponent(ref.id))
      url.searchParams.set('format', 'full')
      return getJson<GmailMessage>(url.toString(), accessToken)
    }))
    for (const result of fetched) {
      if (result.status === 'fulfilled') messages.push(result.value)
      else {
        const detail = result.reason instanceof Error ? result.reason.message : ''
        if (detail.includes('abgelaufen') || detail.includes('abgelehnt')) throw result.reason
        // A deleted, malformed or transiently unavailable individual message
        // should not discard the remaining valid Gmail search results.
      }
    }
  }

  const existingUrls = new Set(products.flatMap(product =>
    [product.incomingTrackingUrl, product.outgoingTrackingUrl]
      .filter((value): value is string => Boolean(value))
      .map(canonicalTrackingUrl)
  ))
  const candidates = messages.flatMap(message => parseMessage(message, products))
    .filter(candidate => !candidate.trackingUrl || !existingUrls.has(canonicalTrackingUrl(candidate.trackingUrl)))

  const existingNumbers = new Set(products.flatMap(product =>
    [product.incomingTrackingNumber, product.outgoingTrackingNumber]
      .filter((value): value is string => Boolean(value))
      .map(value => value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  ))
  const newCandidates = candidates.filter(candidate =>
    !candidate.trackingNumber ||
    !existingNumbers.has(candidate.trackingNumber.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  )

  // Repeated status emails for a parcel are one shipment. When a retailer
  // provides only a number, use the message ID rather than an empty URL key.
  const deduplicated = new Map<string, GmailTrackingCandidate>()
  for (const candidate of newCandidates) {
    const key = trackingCandidateDedupKey(candidate)
    const previous = deduplicated.get(key)
    if (!previous || candidate.date > previous.date) deduplicated.set(key, candidate)
  }
  return [...deduplicated.values()].sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * Optional semantic matching. Only a minimized excerpt, sender domain and
 * product catalogue fields are sent to the same-origin Worker after consent.
 * The Gmail token is forwarded only so the Worker can verify Gmail access.
 */
export async function rankGmailCandidatesWithAI(
  accessToken: string,
  candidates: GmailTrackingCandidate[],
  products: MatchableProduct[],
): Promise<{ matches: AiProductMatch[]; modelsUsed: string[] }> {
  if (!accessToken) throw new Error('Gmail muss für den KI-Abgleich verbunden sein.')
  const response = await fetch('/api/shipping/match', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      candidates: candidates.map(candidate => ({
        id: candidate.id,
        direction: candidate.direction,
        date: candidate.date,
        text: candidate.matchText,
        senderDomain: candidate.senderDomain,
      })),
      products: products.map(product => ({
        id: product.id,
        name: product.name,
        category: product.category || '',
        platform: product.platform || '',
        purchaseDate: product.purchaseDate || '',
        saleDate: product.saleDate || '',
        status: product.status || '',
      })),
    }),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(detail.error || 'Der KI-Produktabgleich ist fehlgeschlagen (HTTP ' + response.status + ').')
  }
  const result = await response.json() as { matches?: AiProductMatch[]; modelsUsed?: string[] }
  return {
    matches: Array.isArray(result.matches) ? result.matches : [],
    modelsUsed: Array.isArray(result.modelsUsed) ? result.modelsUsed : [],
  }
}

function subjectTokens(subject: string): string[] {
  return productTokens(subject)
}

export function createGmailLearningHint(
  candidate: GmailTrackingCandidate,
  productId: string,
  products: MatchableProduct[],
  approvedAt = new Date().toISOString(),
): GmailLearningHint | null {
  const product = products.find(item => item.id === productId)
  if (!product || !candidate.senderDomain) return null
  const productIdentity = normalizeText(product.name) + '|' + normalizeText(product.category || '') + '|' + normalizeText(product.platform || '')
  const equivalentProducts = products.filter(item =>
    normalizeText(item.name) + '|' + normalizeText(item.category || '') + '|' + normalizeText(item.platform || '') === productIdentity
  )
  // Never teach a specific unit from a duplicate stock group: an otherwise
  // correct subject could later point to the wrong physical copy.
  if (equivalentProducts.length !== 1) return null
  const tokens = subjectTokens(candidate.subject)
  const productWords = new Set(productTokens(product.name))
  const relevant = tokens.filter(token => productWords.has(token))
  const hasDistinctiveToken = relevant.some(token => token.length >= 8)
  if (relevant.length < 3 && !hasDistinctiveToken) return null
  return {
    senderDomain: candidate.senderDomain.toLowerCase(),
    productId,
    direction: candidate.direction,
    subjectTokens: [...new Set(relevant)],
    approvedAt,
  }
}

export function applyLearnedGmailMatch(
  candidate: GmailTrackingCandidate,
  products: MatchableProduct[],
  hints: GmailLearningHint[],
): GmailTrackingCandidate {
  if (!candidate.senderDomain) return candidate
  const candidateWords = new Set(subjectTokens(candidate.subject))
  const ranked = hints
    .filter(hint => {
      if (hint.senderDomain.toLowerCase() !== candidate.senderDomain.toLowerCase() || hint.direction !== candidate.direction) return false
      const product = products.find(item => item.id === hint.productId)
      if (!product) return false
      const identity = normalizeText(product.name) + '|' + normalizeText(product.category || '') + '|' + normalizeText(product.platform || '')
      return products.filter(item =>
        normalizeText(item.name) + '|' + normalizeText(item.category || '') + '|' + normalizeText(item.platform || '') === identity
      ).length === 1
    })
    .map(hint => {
      const overlap = hint.subjectTokens.filter(token => candidateWords.has(token))
      const longToken = overlap.some(token => token.length >= 8)
      const sufficient = overlap.length >= 3 || longToken
      return { hint, overlap: overlap.length, sufficient, score: overlap.length / Math.max(1, hint.subjectTokens.length) }
    })
    .filter(item => item.sufficient)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap)
  const best = ranked[0]
  const second = ranked[1]
  if (!best || (second && best.score - second.score < 0.2 && best.hint.productId !== second.hint.productId)) return candidate
  if (candidate.suggestedProductId && candidate.matchConfidence >= 0.9 && candidate.suggestedProductId !== best.hint.productId) return candidate
  return {
    ...candidate,
    suggestedProductId: best.hint.productId,
    matchConfidence: Math.max(candidate.matchConfidence, 0.92),
    matchSource: 'Eigene bestätigte Zuordnung',
    matchReason: 'Absender und markante Betreffbegriffe stimmen mit einer früher von dir bestätigten Zuordnung überein.',
  }
}

export function mergeGmailLearningHint(hints: GmailLearningHint[], next: GmailLearningHint | null): GmailLearningHint[] {
  if (!next) return hints
  const key = (item: GmailLearningHint) =>
    item.senderDomain + '|' + item.direction + '|' + item.productId + '|' + [...item.subjectTokens].sort().join('|')
  return [next, ...hints.filter(item => key(item) !== key(next))].slice(0, 100)
}
