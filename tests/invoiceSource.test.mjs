import test from 'node:test'
import assert from 'node:assert/strict'
import { readInvoiceSource } from '../src/lib/invoiceSource.ts'

const progress = () => {}

test('extracts the article name and price from a saved plain-text email invoice', async () => {
  const raw = [
    'From: shop@example.com',
    'To: buyer@example.com',
    'Subject: Ihre Rechnung zu Ihrer Bestellung',
    'Date: Tue, 17 Nov 2026 10:00:00 +0100',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Vielen Dank für Ihre Bestellung.',
    'Artikel: Pokémon 30 Jahre Ditto Premium-Kollektion 46,99 EUR',
    'Gesamtbetrag: 46,99 EUR',
  ].join('\r\n')
  const file = new File([raw], 'online-rechnung.eml', { type: 'message/rfc822' })
  const result = await readInvoiceSource(file, progress)

  assert.equal(result.lineItems.length, 1)
  assert.match(result.lineItems[0].description, /Pokémon.*Ditto/i)
  assert.equal(result.amount, 46.99)
  assert.match(result.backend, /E-Mail-Text/)
})

test('extracts table rows from HTML-only invoice email bodies', async () => {
  const raw = [
    'From: shop@example.com',
    'Subject: Ihre Rechnung',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><h1>Rechnung</h1><table><tr><th>Artikel</th><th>Preis</th></tr>',
    '<tr><td>Pokémon Ditto Premium Collection</td><td>39,99 EUR</td></tr></table>',
    '<p>Gesamtbetrag: 39,99 EUR</p></body></html>',
  ].join('\r\n')
  const file = new File([raw], 'html-rechnung.eml', { type: 'message/rfc822' })
  const result = await readInvoiceSource(file, progress)

  assert.equal(result.lineItems.length, 1)
  assert.match(result.lineItems[0].description, /Ditto Premium Collection/i)
  assert.equal(result.amount, 39.99)
})

test('rejects an email that contains no invoice line item', async () => {
  const raw = [
    'From: shop@example.com',
    'Subject: Newsletter',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Welcome to our newsletter. No purchase was made.',
  ].join('\r\n')
  const file = new File([raw], 'newsletter.eml', { type: 'message/rfc822' })
  await assert.rejects(() => readInvoiceSource(file, progress), /keine eindeutige Artikelposition/)
})
