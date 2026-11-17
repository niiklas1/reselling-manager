import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidBarcode } from '../src/lib/invoiceScanner.ts'
import { productNameSimilarity } from '../src/lib/productLookup.ts'

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
