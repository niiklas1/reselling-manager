import test from 'node:test'
import assert from 'node:assert/strict'
import { convertAmountFromEur, convertAmountToEur, fetchEcbReferenceRates, formatBaseAmount, isSupportedCurrency } from '../src/lib/currency.ts'
const snapshot={date:'2026-11-18',rates:{EUR:1,USD:1.1,GBP:0.85,CHF:0.92,PLN:4.4,CZK:24.3,JPY:175,CNY:7.3,AUD:1.63,CAD:1.57}}
test('foreign purchase amounts convert into euro accounting base',()=>{
 assert.equal(convertAmountToEur(110,'USD',snapshot),100)
 assert.equal(convertAmountToEur(85,'GBP',snapshot),100)
 assert.equal(convertAmountToEur(100,'EUR',snapshot),100)
})
test('euro values convert to selected display currency',()=>{
 assert.equal(convertAmountFromEur(100,'USD',snapshot.rates),110)
 assert.match(formatBaseAmount(100,'PLN',snapshot.rates),/440/)
})
test('unsupported currencies and missing reference rates are rejected',()=>{
 assert.equal(isSupportedCurrency('USD'),true)
 assert.equal(isSupportedCurrency('XYZ'),false)
 assert.throws(()=>convertAmountToEur(100,'USD',{date:'',rates:{EUR:1}}),/kein gültiger Referenzkurs/)
})
test('ECB provider response is normalized and checked',async()=>{
 let requested=''
 const fakeFetch=async input=>new Response(JSON.stringify([
  {date:'2026-11-18',base:'EUR',quote:'USD',rate:1.1},
  {date:'2026-11-18',base:'EUR',quote:'GBP',rate:0.85},
 ]),{status:200,headers:{'Content-Type':'application/json'}})
 const result=await fetchEcbReferenceRates(async input=>{requested=String(input);return fakeFetch(input)})
 assert.match(requested,/providers\/ecb\/rates/)
 assert.equal(result.date,'2026-11-18')
 assert.equal(result.rates.USD,1.1)
 assert.equal(result.rates.EUR,1)
})
