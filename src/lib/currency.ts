export const CURRENCY_OPTIONS = [
 { code:'EUR', label:'Euro' }, { code:'USD', label:'US-Dollar' }, { code:'GBP', label:'Britisches Pfund' },
 { code:'CHF', label:'Schweizer Franken' }, { code:'PLN', label:'Polnischer Zloty' }, { code:'CZK', label:'Tschechische Krone' },
 { code:'JPY', label:'Japanischer Yen' }, { code:'CNY', label:'Chinesischer Yuan' }, { code:'AUD', label:'Australischer Dollar' },
 { code:'CAD', label:'Kanadischer Dollar' },
] as const
export type CurrencyCode = typeof CURRENCY_OPTIONS[number]['code']
export type ExchangeRates = Partial<Record<CurrencyCode, number>>
export type ExchangeRateSnapshot = { date: string; rates: ExchangeRates }
export const EMPTY_EXCHANGE_RATES: ExchangeRateSnapshot = { date:'', rates:{ EUR:1 } }
const CACHE_KEY='reselling-manager-fx-rates'
const CURRENCY_CODES=new Set<string>(CURRENCY_OPTIONS.map(option=>option.code))
export function isSupportedCurrency(value: unknown): value is CurrencyCode {
 return typeof value==='string' && CURRENCY_CODES.has(value)
}
export function convertAmountToEur(amount:number, sourceCurrency:CurrencyCode, snapshot:ExchangeRateSnapshot):number {
 if(!Number.isFinite(amount)) throw new Error('Der Betrag muss eine gültige Zahl sein.')
 if(sourceCurrency==='EUR') return Math.round((amount+Number.EPSILON)*100)/100
 const rate=snapshot.rates[sourceCurrency]
 if(!Number.isFinite(rate)||!rate||rate<=0) throw new Error(`Für ${sourceCurrency} ist gerade kein gültiger Referenzkurs verfügbar.`)
 return Math.round((amount/rate+Number.EPSILON)*100)/100
}
export function convertAmountFromEur(amount:number, targetCurrency:CurrencyCode, rates:ExchangeRates):number {
 if(!Number.isFinite(amount)) throw new Error('Der Betrag muss eine gültige Zahl sein.')
 if(targetCurrency==='EUR') return amount
 const rate=rates[targetCurrency]
 if(!Number.isFinite(rate)||!rate||rate<=0) throw new Error(`Für ${targetCurrency} ist gerade kein gültiger Referenzkurs verfügbar.`)
 return amount*rate
}
export function formatBaseAmount(amount:number, displayCurrency:CurrencyCode, rates:ExchangeRates):string {
 const hasRate=displayCurrency==='EUR'||Boolean(rates[displayCurrency]&&rates[displayCurrency]!>0)
 const currency=hasRate?displayCurrency:'EUR'
 const converted=currency==='EUR'?amount:convertAmountFromEur(amount,currency,rates)
 return new Intl.NumberFormat('de-DE',{style:'currency',currency}).format(converted)
}
export async function fetchEcbReferenceRates(fetcher:typeof fetch=fetch):Promise<ExchangeRateSnapshot> {
 const quotes=CURRENCY_OPTIONS.filter(option=>option.code!=='EUR').map(option=>option.code.toLowerCase()).join(',')
 const response=await fetcher(`https://api.frankfurter.dev/v2/providers/ecb/rates?base=eur&quotes=${quotes}`,{headers:{Accept:'application/json'},cache:'no-store'})
 if(!response.ok) throw new Error('EZB-Wechselkurse sind gerade nicht erreichbar. Bitte versuche es später erneut.')
 const rows=await response.json() as Array<{date?:string;base?:string;quote?:string;rate?:number}>
 if(!Array.isArray(rows)||rows.length===0) throw new Error('Der Wechselkursdienst hat keine aktuellen EZB-Kurse zurückgegeben.')
 const validRows=rows.filter(row=>typeof row.date==='string'&&row.base?.toUpperCase()==='EUR'&&typeof row.quote==='string'&&isSupportedCurrency(row.quote.toUpperCase())&&Number.isFinite(row.rate)&&Number(row.rate)>0)
 if(!validRows.length) throw new Error('Die zurückgegebenen Wechselkurse haben ein unerwartetes Format.')
 const latestDate=validRows.map(row=>row.date as string).sort().at(-1) as string
 const rates:ExchangeRates={EUR:1}
 for(const row of validRows) if(row.date===latestDate) rates[row.quote!.toUpperCase() as CurrencyCode]=Number(row.rate)
 return {date:latestDate,rates}
}
export function readCachedExchangeRates():ExchangeRateSnapshot {
 if(typeof localStorage==='undefined') return EMPTY_EXCHANGE_RATES
 try {
  const parsed=JSON.parse(localStorage.getItem(CACHE_KEY)||'null') as Partial<ExchangeRateSnapshot>|null
  if(!parsed||typeof parsed.date!=='string'||!parsed.rates||typeof parsed.rates!=='object') return EMPTY_EXCHANGE_RATES
  const rates:ExchangeRates={EUR:1}
  for(const [code,rawRate] of Object.entries(parsed.rates)) if(isSupportedCurrency(code)&&Number.isFinite(rawRate)&&Number(rawRate)>0) rates[code]=Number(rawRate)
  return {date:parsed.date,rates}
 } catch { return EMPTY_EXCHANGE_RATES }
}
export function saveCachedExchangeRates(snapshot:ExchangeRateSnapshot):void {
 if(typeof localStorage==='undefined') return
 try { localStorage.setItem(CACHE_KEY,JSON.stringify(snapshot)) } catch { /* cache only; never block product data */ }
}
