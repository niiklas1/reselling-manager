import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInvoiceText } from '../src/lib/invoiceScanner.ts'

test('keeps the single Ditto line and rejects register/payment metadata', () => {
  const text = [
    'MEGA CARD SHOP',
    'Artikel Beschreibung Menge Einzelpreis Gesamtpreis',
    'Ditto Premium Collection 1 x 39,99',
    'Kassennummer 123456789 12,99',
    'Transaktionsnummer 983456123 8,99',
    'Kartenzahlung VISA 1234 49,99',
    'Zwischensumme 39,99',
    'MwSt 19% 7,60',
    'Gesamtbetrag 47,59',
  ].join('\n')

  const result = parseInvoiceText(text)
  assert.equal(result.lineItems.length, 1)
  assert.equal(result.lineItems[0].description, 'Ditto Premium Collection')
  assert.equal(result.lineItems[0].quantity, 1)
  assert.equal(result.lineItems[0].amount, 39.99)
  assert.equal(result.amount, 47.59)
})

test('reads two purchased units and calculates the per-unit purchase price', () => {
  const result = parseInvoiceText([
    'Ditto Premium Collection 2 x 19,99 39,98',
    'Zwischensumme 39,98',
    'Gesamtbetrag 39,98',
  ].join('\n'))

  assert.equal(result.lineItems.length, 1)
  assert.equal(result.lineItems[0].quantity, 2)
  assert.equal(result.lineItems[0].unitPrice, 19.99)
  assert.equal(result.lineItems[0].amount, 39.98)
})

test('does not turn reference numbers and random numeric rows into products', () => {
  const result = parseInvoiceText([
    'ABC ONLINE SHOP',
    'Ditto Premium Collection 29,99',
    'Kassennummer 123456789 5,99',
    'Referenz 22334455 10,00',
    'IBAN DE12345678901234567890',
    'Gesamtbetrag 29,99',
  ].join('\n'))

  assert.equal(result.lineItems.length, 1)
  assert.equal(result.lineItems[0].description, 'Ditto Premium Collection')
})

test('does not guess a product from a page containing only metadata and totals', () => {
  const result = parseInvoiceText([
    'ORDER NUMBER 123456789',
    'CUSTOMER NUMBER 99887766',
    'Kassennummer 551122',
    'Gesamtbetrag 39,99',
    'Kartenzahlung 39,99',
  ].join('\n'))

  assert.equal(result.lineItems.length, 0)
  assert.equal(result.name, '')
  assert.equal(result.amount, 39.99)
})


test('parses a Thalia thermal receipt and ignores SUMME, EC Cash and terminal metadata', () => {
  const result = parseInvoiceText([
    'Thalia Baunatal',
    'Quittung',
    'Art/EAN 196214147454',
    'PKM 30 Jahre Ditto Premi 46,99 |',
    'SUMME [1] EUR 46,99',
    'EC Cash LS EUR 46,99',
    'Kundenbeleg',
    'Kartenzahlung',
    'Referenzpar. 0000000000',
    'Genehmigungs-Nr. 161834',
    'AS-Zeit 17.11. 11:43 Uhr',
    'Weitere Daten /0000000001//A000000359/3F',
    'Betrag EUR 46,99',
    'MWST BRUTTO NETTO 19% 7,50 46,99 39,49',
    'TSE Transaktionsnummer 235609',
  ].join('\n'))

  assert.equal(result.lineItems.length, 1)
  assert.equal(result.lineItems[0].description, 'PKM 30 Jahre Ditto Premi')
  assert.equal(result.lineItems[0].quantity, 1)
  assert.equal(result.lineItems[0].amount, 46.99)
  assert.equal(result.amount, 46.99)
})
