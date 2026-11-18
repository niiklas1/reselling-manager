import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyLearnedGmailMatch,
  createGmailLearningHint,
  decodeMimeWords,
  identifyCarrier,
  isLikelyShippingEmail,
  isSafeTrackingUrl,
  mergeGmailLearningHint,
  trackingCandidateDedupKey,
  scoreProductMatch,
  suggestProductMatch,
} from '../src/lib/gmailShipping.ts'

test('recognizes common German and international carriers', () => {
  assert.equal(identifyCarrier('https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html'), 'DHL')
  assert.equal(identifyCarrier('https://www.ups.com/track'), 'UPS')
  assert.equal(identifyCarrier('https://www.myhermes.de/'), 'Hermes')
  assert.equal(identifyCarrier('https://tracking.dhl.de/'), 'DHL')
  assert.equal(identifyCarrier('https://dhl.attacker.example/'), '')
  assert.equal(identifyCarrier('https://www.royalmail.com/track-your-item'), 'Royal Mail')
  assert.equal(identifyCarrier('https://www.usps.com/'), 'USPS')
  assert.equal(identifyCarrier('https://www.post.at/s/sendungssuche'), 'Österreichische Post')
  assert.equal(identifyCarrier('https://global.cainiao.com/'), 'Cainiao')
  assert.equal(identifyCarrier('https://www.yunexpress.com/'), 'YunExpress')
  assert.equal(identifyCarrier('https://www.sf-express.com/'), 'SF Express')
  assert.equal(identifyCarrier('https://www.mondialrelay.fr/'), 'Mondial Relay')
})

test('accepts explicit tracking endpoints and rejects unsafe or unrelated URLs', () => {
  assert.equal(isSafeTrackingUrl('https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html'), true)
  assert.equal(isSafeTrackingUrl('http://www.dhl.de/track'), false)
  assert.equal(isSafeTrackingUrl('javascript:alert(1)'), false)
  assert.equal(isSafeTrackingUrl('https://example.com/about-us'), false)
  assert.equal(isSafeTrackingUrl('https://dhl.attacker.example/track'), false)
  assert.equal(isSafeTrackingUrl('https://royalmail-attacker.example/track'), false)
  assert.equal(isSafeTrackingUrl('https://example-shop.de/track-shipment/123'), true)
  assert.equal(isSafeTrackingUrl('https://example-shop.de/delivery/offers'), false)
})

test('recognizes shipping notifications but rejects generic marketing mail', () => {
  assert.equal(isLikelyShippingEmail('Your order has shipped', 'Track your package using the link below.'), true)
  assert.equal(isLikelyShippingEmail('Versandbestätigung', 'Ihre Sendung ist unterwegs.'), true)
  assert.equal(isLikelyShippingEmail('Taylor Swift - New Collection', 'Discover the new merch and preorder now.'), false)
  assert.equal(isLikelyShippingEmail('Universal Music Newsletter', 'Exclusive offers and new releases this week.'), false)
})

test('requires meaningful product-specific terms for confident auto-suggestion', () => {
  assert.ok(scoreProductMatch('Pokémon Hidden Fates Elite Trainer Box', 'Your Pokémon Hidden Fates order has shipped') >= 0.78)
  assert.ok(scoreProductMatch('Pokémon Hidden Fates Elite Trainer Box', 'Your order has shipped') < 0.78)
})

test('does not auto-assign when multiple inventory units match equally', () => {
  const products = [
    { id: 'unit-1', name: 'Pokémon Hidden Fates Elite Trainer Box' },
    { id: 'unit-2', name: 'Pokémon Hidden Fates Elite Trainer Box' },
  ]
  const match = suggestProductMatch(products, 'Your Pokémon Hidden Fates order has shipped')
  assert.equal(match.productId, '')
  assert.ok(match.confidence >= 0.78)
})

test('suggests a product only when its match is clearly stronger', () => {
  const products = [
    { id: 'hidden-fates', name: 'Pokémon Hidden Fates Elite Trainer Box' },
    { id: 'vivid-voltage', name: 'Pokémon Vivid Voltage Elite Trainer Box' },
  ]
  const match = suggestProductMatch(products, 'Your Pokémon Hidden Fates order has shipped')
  assert.equal(match.productId, 'hidden-fates')
})

test('recognizes carrier handover and pickup updates', () => {
  assert.equal(isLikelyShippingEmail('Your order has been handed to the carrier', 'The parcel is in transit.'), true)
  assert.equal(isLikelyShippingEmail('Abholbereit', 'Ihr Paket ist zur Abholung bereit.'), true)
  assert.equal(isLikelyShippingEmail('Delivery attempt', 'The courier attempted delivery today.'), true)
})

test('learns only distinctive sender and subject combinations after confirmation', () => {
  const products = [
    { id: 'vinyl', name: 'Taylor Swift The Life of a Showgirl Vinyl' },
    { id: 'pokemon', name: 'Pokémon Hidden Fates Elite Trainer Box' },
  ]
  const candidate = {
    id: 'mail-1:0',
    messageId: 'mail-1',
    threadId: 'thread-1',
    subject: 'Taylor Swift The Life of a Showgirl vinyl has shipped',
    sender: 'Universal Store <shipping@universal-music.example>',
    senderDomain: 'universal-music.example',
    date: '2026-11-18T10:00:00.000Z',
    direction: 'incoming',
    carrier: 'Versanddienst',
    trackingNumber: 'AB123456789',
    trackingUrl: 'https://shop.example/track/AB123456789',
    snippet: 'Your order has shipped',
    matchText: 'Taylor Swift The Life of a Showgirl vinyl has shipped',
    suggestedProductId: '',
    matchConfidence: 0,
  }
  const hint = createGmailLearningHint(candidate, 'vinyl', products, '2026-11-18T10:01:00.000Z')
  assert.ok(hint)
  assert.ok(hint.subjectTokens.includes('taylor'))
  const saved = mergeGmailLearningHint([], hint)
  assert.equal(saved.length, 1)

  const future = {
    ...candidate,
    id: 'mail-2:0',
    subject: 'Your Taylor Swift The Life of a Showgirl vinyl is on its way',
    suggestedProductId: '',
    matchConfidence: 0,
  }
  const suggested = applyLearnedGmailMatch(future, products, saved)
  assert.equal(suggested.suggestedProductId, 'vinyl')
  assert.equal(suggested.matchSource, 'Eigene bestätigte Zuordnung')
})

test('does not learn generic retailer-only mail subjects or ambiguous conflicts', () => {
  const products = [
    { id: 'vinyl', name: 'Taylor Swift The Life of a Showgirl Vinyl' },
    { id: 'pokemon', name: 'Pokémon Hidden Fates Elite Trainer Box' },
  ]
  const generic = {
    id: 'mail-3:0',
    messageId: 'mail-3',
    threadId: 'thread-3',
    subject: 'Your order has shipped',
    sender: 'Universal Store <shipping@universal-music.example>',
    senderDomain: 'universal-music.example',
    date: '2026-11-18T10:00:00.000Z',
    direction: 'incoming',
    carrier: 'Versanddienst',
    trackingNumber: '',
    trackingUrl: 'https://shop.example/order/123456789',
    snippet: 'Your order is on its way',
    matchText: 'Your order has shipped',
    suggestedProductId: '',
    matchConfidence: 0,
  }
  assert.equal(createGmailLearningHint(generic, 'vinyl', products), null)
  const a = createGmailLearningHint({
    ...generic,
    subject: 'Taylor Swift The Life of a Showgirl vinyl has shipped',
  }, 'vinyl', products)
  const b = createGmailLearningHint({
    ...generic,
    subject: 'Taylor Swift The Life of a Showgirl vinyl has shipped',
  }, 'pokemon', products)
  const ambiguous = applyLearnedGmailMatch(generic, products, [a, b].filter(Boolean))
  assert.equal(ambiguous.suggestedProductId, '')
})

test('decodes RFC 2047 encoded Gmail headers', () => {
  assert.equal(decodeMimeWords('=?UTF-8?Q?Versandbest=C3=A4tigung?='), 'Versandbestätigung')
  assert.equal(decodeMimeWords('Subject =?UTF-8?B?VGF5bG9yIFN3aWZ0?='), 'Subject Taylor Swift')
})

test('uses the confirmed sender and subject pairing without guessing from sender alone', () => {
  const products = [
    { id: 'vinyl', name: 'Taylor Swift The Life of a Showgirl Vinyl' },
    { id: 'pokemon', name: 'Pokémon Hidden Fates Elite Trainer Box' },
  ]
  const candidate = {
    id: 'mail-4:0',
    messageId: 'mail-4',
    threadId: 'thread-4',
    subject: 'Taylor Swift The Life of a Showgirl vinyl has shipped',
    sender: 'Universal Store <shipping@universal-music.example>',
    senderDomain: 'universal-music.example',
    date: '2026-11-18T10:00:00.000Z',
    direction: 'incoming',
    carrier: 'Versanddienst',
    trackingNumber: '',
    trackingUrl: 'https://shop.example/track/123456789',
    snippet: 'Your order is on its way',
    matchText: 'Taylor Swift The Life of a Showgirl vinyl has shipped',
    suggestedProductId: '',
    matchConfidence: 0,
  }
  const hint = createGmailLearningHint(candidate, 'vinyl', products, '2026-11-18T10:01:00.000Z')
  assert.ok(hint)
  const conflictingHint = { ...hint, productId: 'vinyl-duplicate' }
  const ambiguous = applyLearnedGmailMatch(candidate, products, [hint, conflictingHint])
  assert.equal(ambiguous.suggestedProductId, '')
})

test('keeps distinct number-only shipment emails while deduplicating the same parcel', () => {
  assert.notEqual(
    trackingCandidateDedupKey({ trackingNumber: '', trackingUrl: '', messageId: 'message-a' }),
    trackingCandidateDedupKey({ trackingNumber: '', trackingUrl: '', messageId: 'message-b' })
  )
  assert.equal(
    trackingCandidateDedupKey({ trackingNumber: 'AB 123456789', trackingUrl: '', messageId: 'message-a' }),
    trackingCandidateDedupKey({ trackingNumber: 'AB123456789', trackingUrl: 'https://parcel.example/track/other', messageId: 'message-b' })
  )
  assert.equal(
    trackingCandidateDedupKey({ trackingNumber: '', trackingUrl: 'https://parcel.example/track/123?utm_source=mail', messageId: 'message-a' }),
    trackingCandidateDedupKey({ trackingNumber: '', trackingUrl: 'https://parcel.example/track/123', messageId: 'message-b' })
  )
})

test('does not create local learning rules for duplicate units of the same product', () => {
  const products = [
    { id: 'unit-a', name: 'Taylor Swift The Life of a Showgirl Vinyl', category: 'Alternative', platform: 'Universal Music' },
    { id: 'unit-b', name: 'Taylor Swift The Life of a Showgirl Vinyl', category: 'Alternative', platform: 'Universal Music' },
  ]
  const candidate = {
    id: 'mail-5:0',
    messageId: 'mail-5',
    threadId: 'thread-5',
    subject: 'Taylor Swift The Life of a Showgirl vinyl has shipped',
    sender: 'Universal Store <shipping@universal-music.example>',
    senderDomain: 'universal-music.example',
    date: '2026-11-18T10:00:00.000Z',
    direction: 'incoming',
    carrier: 'Versanddienst',
    trackingNumber: 'AB123456789',
    trackingUrl: 'https://shop.example/track/AB123456789',
    snippet: 'Your order has shipped',
    matchText: 'Taylor Swift The Life of a Showgirl vinyl has shipped',
    suggestedProductId: '',
    matchConfidence: 0,
  }
  assert.equal(createGmailLearningHint(candidate, 'unit-a', products), null)
})
