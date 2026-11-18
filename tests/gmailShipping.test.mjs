import test from 'node:test'
import assert from 'node:assert/strict'
import {
  identifyCarrier,
  isSafeTrackingUrl,
  scoreProductMatch,
  suggestProductMatch,
} from '../src/lib/gmailShipping.ts'

test('recognizes common German and international carriers', () => {
  assert.equal(identifyCarrier('https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html'), 'DHL')
  assert.equal(identifyCarrier('https://www.ups.com/track'), 'UPS')
  assert.equal(identifyCarrier('https://www.myhermes.de/'), 'Hermes')
})

test('accepts HTTPS tracking links and rejects unsafe protocols or unrelated links', () => {
  assert.equal(isSafeTrackingUrl('https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html'), true)
  assert.equal(isSafeTrackingUrl('http://www.dhl.de/track'), false)
  assert.equal(isSafeTrackingUrl('javascript:alert(1)'), false)
  assert.equal(isSafeTrackingUrl('https://example.com/about-us'), false)
  assert.equal(isSafeTrackingUrl('https://example-shop.de/track-shipment/123'), true)
})

test('requires multiple matching product words for confident auto-assignment', () => {
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
