import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidBarcode } from '../src/lib/invoiceScanner.ts'
import { enrichInvoiceProductNames, productNameSimilarity } from '../src/lib/productLookup.ts'

test('validates common UPC and EAN check digits', () => {
  assert.equal(isValidBarcode('196214147454'), true)
  assert.equal(isValidBarcode('4006381333931'), true)
  assert.equal(isValidBarcode('036000291452'), true)
})

test('rejects invalid check digits and non-barcode lengths', () => {
  assert.equal(isValidBarcode('196214147455'), false)
  assert.equal(isValidBarcode('1234567'), false)
  assert.equal(isValidBarcode('123456789012345'), false)
})

test('matches OCR abbreviations and truncations to a real catalog title', () => {
  const score = productNameSimilarity(
    'PKM 30 Jahre Ditto Premi',
    'Pokémon 30 Jahre Ditto Premium-Kollektion DE',
  )
  assert.ok(score >= 0.68, String(score))
})

test('does not match a payment terminal row to a product title', () => {
  assert.ok(productNameSimilarity('EC Cash Contactless', 'Pokémon Ditto Premium Collection') < 0.4)
})


test('replaces noisy Ditto OCR with the exact barcode catalogue title', async () => {
  const originalFetch = globalThis.fetch
  const originalStorage = globalThis.localStorage
  const values = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
  })
  globalThis.fetch = async input => {
    assert.match(String(input), /\/api\/product\/lookup\?barcodes=196214147454/)
    return new Response(JSON.stringify({
      code: 'OK',
      items: [{
        upc: '196214147454',
        ean: '0196214147454',
        title: '30 Jahre Ditto Premium-Kollektion DE',
        brand: 'Pokémon',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const result = await enrichInvoiceProductNames([{
      id: 'line-1',
      description: 'PKM 30 Jahre Ditto Premi',
      quantity: 1,
      unitPrice: 46.99,
      amount: 46.99,
      confidence: 0.69,
      barcode: '196214147454',
    }])
    assert.equal(result[0].description, '30 Jahre Ditto Premium-Kollektion DE')
    assert.equal(result[0].productVerified, true)
    assert.equal(result[0].confidence, 0.99)
  } finally {
    globalThis.fetch = originalFetch
    if (originalStorage === undefined) delete globalThis.localStorage
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage })
  }
})
