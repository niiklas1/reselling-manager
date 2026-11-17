import { recognizeInvoiceWithAI, type FlorenceOcrResult } from './invoiceAi.ts'

export type InvoiceLineItem = {
  id: string
  description: string
  quantity: number
  unitPrice: number | null
  amount: number
  confidence: number
}

export type InvoiceExtraction = {
  text: string
  name: string
  amount: number | null
  date: string
  quantity: number
  lineItems: InvoiceLineItem[]
  recognition: 'local-ai' | 'browser-ocr' | 'pdf-text'
  backend: string
}

type PositionedLine = { text: string; left: number; top: number; bottom: number }

function parseEuro(value: string): number | null {
  let normalized = value.replace(/(?:EUR|USD|GBP|CHF)/gi, '').replace(/[€$£\s]/g, '').replace(/[^\d,.-]/g, '')
  const comma = normalized.lastIndexOf(',')
  const dot = normalized.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) normalized = normalized.replace(/\./g, '').replace(',', '.')
    else normalized = normalized.replace(/,/g, '')
  } else if (comma >= 0) {
    normalized = normalized.replace(',', '.')
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function positionedLines(labels: string[], boxes: number[][]): string[] {
  const regions: PositionedLine[] = labels.map((text, index) => {
    const quad = boxes[index] || []
    const xs = [quad[0], quad[2], quad[4], quad[6]].filter(Number.isFinite)
    const ys = [quad[1], quad[3], quad[5], quad[7]].filter(Number.isFinite)
    return {
      text: text.trim(),
      left: xs.length ? Math.min(...xs) : 0,
      top: ys.length ? Math.min(...ys) : index * 100,
      bottom: ys.length ? Math.max(...ys) : index * 100 + 20,
    }
  }).filter(item => item.text).sort((a, b) => a.top - b.top || a.left - b.left)

  const rows: Array<{ top: number; bottom: number; cells: PositionedLine[] }> = []
  for (const region of regions) {
    const height = Math.max(1, region.bottom - region.top)
    let bestRow: typeof rows[number] | undefined
    let bestDistance = Infinity
    for (const row of rows) {
      const rowHeight = Math.max(1, row.bottom - row.top)
      const overlap = Math.min(region.bottom, row.bottom) - Math.max(region.top, row.top)
      const distance = Math.abs((region.top + region.bottom) / 2 - (row.top + row.bottom) / 2)
      if (overlap > Math.min(height, rowHeight) * 0.35 || distance < Math.max(height, rowHeight) * 0.45) {
        if (distance < bestDistance) {
          bestDistance = distance
          bestRow = row
        }
      }
    }
    if (bestRow) {
      bestRow.cells.push(region)
      bestRow.top = Math.min(bestRow.top, region.top)
      bestRow.bottom = Math.max(bestRow.bottom, region.bottom)
    } else {
      rows.push({ top: region.top, bottom: region.bottom, cells: [region] })
    }
  }
  return rows
    .sort((a, b) => a.top - b.top)
    .map(row => row.cells.sort((a, b) => a.left - b.left).map(cell => cell.text).join(' ').replace(/\s+/g, ' ').trim())
}

function pdfTextByPosition(items: unknown[]): string {
  const entries = items.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || !('str' in raw) || typeof raw.str !== 'string') return []
    const item = raw as { str: string; transform?: number[] }
    const x = Number(item.transform?.[4] ?? 0)
    const y = Number(item.transform?.[5] ?? 0)
    return item.str.trim() ? [{ text: item.str.trim(), x, y, index }] : []
  }).sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index)

  const rows: Array<{ y: number; cells: typeof entries }> = []
  for (const entry of entries) {
    const row = rows.find(candidate => Math.abs(candidate.y - entry.y) < 3)
    if (row) row.cells.push(entry)
    else rows.push({ y: entry.y, cells: [entry] })
  }
  return rows.sort((a, b) => b.y - a.y)
    .map(row => row.cells.sort((a, b) => a.x - b.x).map(cell => cell.text).join(' ').replace(/\s+/g, ' ').trim())
    .join('\n')
}

type MoneyToken = { value: number; index: number; raw: string }

const MONEY_PATTERN = /(?:€|EUR\s*)?\s*(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{2}\s*(?:€|EUR)?/gi

function parseMoneyMatches(line: string): MoneyToken[] {
  return [...line.matchAll(MONEY_PATTERN)].flatMap(match => {
    const value = parseEuro(match[0])
    return value === null ? [] : [{ value, index: match.index ?? 0, raw: match[0] }]
  })
}

const SUMMARY_START = /\b(zwischensumme|warenwert|summe\s+artikel|artikel\s*summe|subtotal|gesamtbetrag|rechnungsbetrag|endbetrag|endsumme|zu\s+zahlen|zahlbetrag|mwst|mehrwertsteuer|umsatzsteuer|steuerbetrag|vat|tax\s+total|amount\s+due|invoice\s+total|gesamt\s*brutto)\b/i
const EXCLUDED_ROW = /\b(gesamtbetrag|rechnungsbetrag|endbetrag|endsumme|zu\s+zahlen|zahlbetrag|zwischensumme|warenwert|subtotal|summe|total|brutto|netto|mwst|ust\.?|mehrwertsteuer|umsatzsteuer|steuerbetrag|rückgeld|gegeben|kartenzahlung|barzahlung|ec[- ]?karte|kreditkarte|visa|mastercard|paypal|zahlung|bezahlt|gutschein|rabatt|versandkosten|lieferkosten|porto|pfand|kaution|anzahlung|gebühr|gebuehr|transaktionsnummer|autorisierung|terminal|kasse|kassen?nummer|kassen[- ]?nr|bonnummer|belegnummer|quittungsnummer|rechnungsnummer|kundennummer|bestellnummer|auftragsnummer|lieferant|rechnung|quittung|kassenbon|datum|uhrzeit|telefon|tel\.?|fax|email|e-mail|www\.|https?:|iban|bic|filiale|straße|str\.?|plz|adresse|kontakt|kundendienst|öffnungszeiten|oeffnungszeiten|artikelnummer|art\.?\s*nr|sku|ean|gtin|barcode|referenz|reference|transaction\s*(?:id|no|number)|tracking\s*(?:id|no|number)|customer\s*(?:id|no|number)|shipping|delivery|freight|order\s*(?:no|number)|invoice\s*(?:no|number)|page\s+\d|seite\s+\d)\b/i
const TABLE_HEADER_WORDS = /\b(artikel|produkt|beschreibung|bezeichnung|item|description|menge|quantity|qty|anzahl|stück|stk|einzelpreis|stückpreis|unit\s*price|preis|price|betrag|amount|gesamtpreis|line\s*total)\b/i

function detectTableHeader(lines: string[]): number {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const terms = [...line.matchAll(TABLE_HEADER_WORDS)].map(match => match[0].toLowerCase())
    const hasDescription = /artikel|produkt|beschreibung|bezeichnung|item|description/i.test(line)
    const hasPrice = /einzelpreis|stückpreis|unit\s*price|preis|price|betrag|amount|gesamtpreis|line\s*total/i.test(line)
    const hasQuantity = /menge|quantity|qty|anzahl|stück|stk/i.test(line)
    if (terms.length >= 3 || (hasDescription && hasPrice && hasQuantity)) return index
  }
  return -1
}

function findQuantity(line: string): number {
  const match = line.match(/\b(?:qty|quantity|menge|anzahl)\s*[:=]?\s*(\d{1,4})\b|\b(\d{1,4})\s*(?:x|×|stk\.?|stück|pcs?\.?|st\.?)(?=\s|$)/i)
  const value = Number(match?.[1] || match?.[2] || 1)
  return Number.isInteger(value) && value > 0 && value <= 10000 ? value : 1
}

function extractDescription(line: string, prices: MoneyToken[]): string {
  const firstPrice = prices[0]
  const beforePrice = firstPrice ? line.slice(0, firstPrice.index) : line
  return beforePrice
    .replace(/^\s*(?:pos\.?\s*)?\d{1,3}[.)#:-]?\s+/i, '')
    .replace(/\b(?:qty|quantity|menge|anzahl)\s*[:=]?\s*\d{1,4}\b/ig, ' ')
    .replace(/\b\d{1,4}\s*(?:x|×|stk\.?|stück|pcs?\.?|st\.?)\b/ig, ' ')
    .replace(/\b(?:ean|gtin|sku|artikelnummer|art\.?\s*nr)\s*[:#-]?\s*[A-Z0-9-]{5,}\b/ig, ' ')
    .replace(/[|:;–-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function candidateConfidence(line: string, description: string, quantity: number, prices: MoneyToken[], hasHeader: boolean): number {
  const words = description.match(/[A-Za-zÄÖÜäöüß]{2,}/g) || []
  const letters = (description.match(/[A-Za-zÄÖÜäöüß]/g) || []).length
  const digits = (description.match(/\d/g) || []).length
  const currencyMarker = /€|\bEUR\b/i.test(line)
  const hasQuantityMarker = quantity > 1 || /\b(?:qty|quantity|menge|anzahl|\d+\s*(?:x|×|stk\.?|stück|pcs?))\b/i.test(line)
  const hasTwoPrices = prices.length >= 2
  const longestWord = Math.max(0, ...words.map(word => word.length))
  let score = 0.36
  if (words.length >= 2) score += 0.15
  else if (longestWord >= 6) score += 0.13
  if (currencyMarker) score += 0.10
  if (hasQuantityMarker) score += 0.12
  if (hasTwoPrices) score += 0.11
  if (hasHeader) score += 0.10
  if (description.length >= 12 && letters >= 8) score += 0.05
  if (digits > 0 && digits > letters * 0.8) score -= 0.22
  if (line.length > 140) score -= 0.12
  return Math.max(0, Math.min(0.99, score))
}

function findSummaryAmount(lines: string[], pattern: RegExp): number | null {
  for (const line of lines) {
    if (!pattern.test(line)) continue
    const matches = parseMoneyMatches(line)
    if (matches.length) return matches[matches.length - 1].value
  }
  return null
}

function selectCandidatesAgainstSubtotal(candidates: InvoiceLineItem[], target: number): InvoiceLineItem[] {
  if (candidates.length < 2 || !Number.isFinite(target) || target <= 0) return candidates
  const targetCents = Math.round(target * 100)
  const totalCents = candidates.reduce((sum, item) => sum + Math.round(item.amount * 100), 0)
  if (totalCents <= targetCents + 2) return candidates
  if (targetCents > 2000000 || candidates.length > 60) return candidates.filter(item => item.confidence >= 0.72)

  // Dynamic programming chooses a subset whose line totals reconcile to the printed
  // subtotal. This prevents OCR fragments with plausible-looking prices from becoming
  // extra products when their combined amounts exceed the actual merchandise total.
  const states = new Map<number, { score: number; indexes: number[] }>([[0, { score: 0, indexes: [] }]])
  for (let index = 0; index < candidates.length; index++) {
    const cents = Math.round(candidates[index].amount * 100)
    const prior = [...states.entries()]
    for (const [sum, state] of prior) {
      const next = sum + cents
      if (next > targetCents + 1) continue
      const score = state.score + candidates[index].confidence
      const existing = states.get(next)
      if (!existing || score > existing.score) states.set(next, { score, indexes: [...state.indexes, index] })
    }
    if (states.size > 25000) {
      const ranked = [...states.entries()].sort((a, b) =>
        Math.abs(a[0] - targetCents) - Math.abs(b[0] - targetCents) || b[1].score - a[1].score
      ).slice(0, 25000)
      states.clear()
      ranked.forEach(([sum, state]) => states.set(sum, state))
    }
  }
  const exact = states.get(targetCents) || states.get(targetCents - 1) || states.get(targetCents + 1)
  if (exact?.indexes.length) return exact.indexes.map(index => candidates[index])
  return candidates.filter(item => item.confidence >= 0.76)
}

function parseLineItems(lines: string[]): InvoiceLineItem[] {
  const headerIndex = detectTableHeader(lines)
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0
  const summaryIndex = lines.findIndex((line, index) => index >= startIndex && SUMMARY_START.test(line))
  const endIndex = summaryIndex >= 0 ? summaryIndex : lines.length
  const rows = lines.slice(startIndex, endIndex)
  const result: InvoiceLineItem[] = []

  for (const line of rows) {
    if (!line || EXCLUDED_ROW.test(line)) continue
    if (/https?:\/\/|www\.|@|\b(?:iban|bic|swift)\b/i.test(line)) continue
    const prices = parseMoneyMatches(line)
    if (!prices.length) continue

    const description = extractDescription(line, prices)
    const words = description.match(/[A-Za-zÄÖÜäöüß]{2,}/g) || []
    const letters = (description.match(/[A-Za-zÄÖÜäöüß]/g) || []).length
    const digits = (description.match(/\d/g) || []).length
    const quantity = findQuantity(line)

    if (description.length < 3 || letters < 4 || words.length === 0) continue
    if (description.length > 100 || words.length > 10) continue
    if (digits > letters * 0.8) continue
    if (/^(?:pos(?:ition)?|art(?:ikel)?(?:-?nr)?|sku|ean|barcode|nr\.?|id|ref)\b/i.test(description)) continue
    if (/^[A-Z0-9/_-]{2,24}$/i.test(description) && !/\s/.test(description)) continue

    const confidence = candidateConfidence(line, description, quantity, prices, headerIndex >= 0)
    const hasProductLikeDescription = words.length >= 2 || Math.max(...words.map(word => word.length)) >= 6
    if (!hasProductLikeDescription || confidence < 0.55) continue

    const lineAmount = prices[prices.length - 1].value
    const unitPrice = quantity > 1
      ? (prices.length >= 2 ? prices[prices.length - 2].value : lineAmount / quantity)
      : (prices.length >= 2 ? prices[prices.length - 2].value : lineAmount)
    const amount = Number(lineAmount.toFixed(2))
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) continue

    result.push({
      id: 'line-' + (result.length + 1),
      description,
      quantity,
      unitPrice: Number(unitPrice.toFixed(2)),
      amount,
      confidence: Number(confidence.toFixed(2)),
    })
  }

  const subtotal = findSummaryAmount(lines, /\b(zwischensumme|warenwert|summe\s+artikel|artikel\s*summe|subtotal)\b/i)
  if (subtotal !== null) return selectCandidatesAgainstSubtotal(result, subtotal)
  const grandTotal = findSummaryAmount(lines, /\b(gesamtbetrag|rechnungsbetrag|endbetrag|endsumme|zu\s+zahlen|zahlbetrag|invoice\s+total|amount\s+due)\b/i)
  return grandTotal !== null ? selectCandidatesAgainstSubtotal(result, grandTotal) : result
}

function parseTotal(text: string): number | null {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const priority = /\b(gesamtbetrag|rechnungsbetrag|endbetrag|endsumme|zu\s+zahlen|zahlbetrag|invoice\s+total|amount\s+due|total\s+amount)\b/i
  const first = findSummaryAmount(lines, priority)
  if (first !== null) return first
  return findSummaryAmount(lines, /\b(brutto|total|summe)\b/i)
}

export function parseInvoiceText(
  rawText: string,
  recognition: InvoiceExtraction['recognition'] = 'browser-ocr',
  backend = 'Tesseract.js',
): InvoiceExtraction {
  const text = rawText.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ')
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const lineItems = parseLineItems(lines)
  const total = parseTotal(text)
  const amount = total ?? (lineItems.length ? lineItems.reduce((sum, item) => sum + item.amount, 0) : null)
  const dateMatch = text.match(/\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](20\d{2})\b/)
  const date = dateMatch
    ? dateMatch[3] + '-' + dateMatch[2].padStart(2, '0') + '-' + dateMatch[1].padStart(2, '0')
    : ''
  const name = lineItems[0]?.description || ''
  const quantity = lineItems.length ? lineItems.reduce((sum, item) => sum + item.quantity, 0) : 1
  return { text, name, amount, date, quantity, lineItems, recognition, backend }
}

async function recognizeCanvas(canvas: HTMLCanvasElement, onProgress: (value: number) => void): Promise<string> {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('deu+eng', 1, {
    logger: message => {
      if (typeof message.progress === 'number') onProgress(message.progress)
    },
  })
  try {
    const result = await worker.recognize(canvas, {}, { blocks: true })
    const structuredLines = (result.data.blocks || []).flatMap(block =>
      block.paragraphs.flatMap(paragraph =>
        paragraph.lines
          .filter(line => line.confidence >= 30 && line.text.trim())
          .map(line => ({ text: line.text.trim(), confidence: line.confidence }))
      )
    )
    if (structuredLines.length) return structuredLines.map(line => line.text).join('\n')
    return result.data.text || ''
  } finally {
    await worker.terminate()
  }
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PDF-Seite konnte nicht als Bild vorbereitet werden.')), 'image/png')
  })
}

async function recognizeWithBestEngine(
  image: Blob,
  onProgress: (value: number, stage: string) => void,
): Promise<{ text: string; recognition: 'local-ai' | 'browser-ocr'; backend: string }> {
  try {
    const result: FlorenceOcrResult = await recognizeInvoiceWithAI(image, onProgress)
    const text = positionedLines(result.labels, result.boxes).join('\n')
    if (!text.trim()) throw new Error('Die lokale KI hat keinen lesbaren Text erkannt.')
    return { text, recognition: 'local-ai', backend: result.backend }
  } catch (aiError) {
    onProgress(0.9, 'Lokale KI nicht verfügbar – nutze einfache Browser-Texterkennung')
    const objectUrl = URL.createObjectURL(image)
    try {
      const img = new Image()
      img.src = objectUrl
      await img.decode()
      const canvas = document.createElement('canvas')
      const scale = Math.min(2, 2200 / Math.max(img.naturalWidth, img.naturalHeight))
      canvas.width = Math.round(img.naturalWidth * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      const context = canvas.getContext('2d')
      if (!context) throw aiError
      context.drawImage(img, 0, 0, canvas.width, canvas.height)
      const text = await recognizeCanvas(canvas, value => onProgress(0.9 + value * 0.1, 'Texterkennung läuft'))
      if (!text.trim()) throw aiError
      return { text, recognition: 'browser-ocr', backend: 'Tesseract.js' }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }
}

export async function readInvoiceFile(
  file: File,
  onProgress: (value: number, stage: string) => void,
): Promise<InvoiceExtraction> {
  const maxSize = 10 * 1024 * 1024
  if (file.size > maxSize) throw new Error('Die Datei ist größer als 10 MB. Bitte wähle eine kleinere Datei.')
  let extractedText = ''
  let recognition: InvoiceExtraction['recognition'] = 'browser-ocr'
  let backend = 'Tesseract.js'

  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    onProgress(0.03, 'PDF wird geöffnet')
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    const pageCount = Math.min(pdf.numPages, 8)
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      onProgress(0.05 + (pageNumber / pageCount) * 0.12, 'PDF-Text und Tabellen werden gelesen')
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      pageTexts.push(pdfTextByPosition(content.items))
    }
    extractedText = pageTexts.filter(Boolean).join('\n\n')

    if (extractedText.replace(/\s/g, '').length < 25) {
      const ocrPages: string[] = []
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        onProgress(0.18 + (pageNumber / pageCount) * 0.72, 'Gescannte PDF-Seite ' + pageNumber + '/' + pageCount)
        const page = await pdf.getPage(pageNumber)
        const viewport = page.getViewport({ scale: 1.7 })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) continue
        await page.render({ canvas, canvasContext: context, viewport }).promise
        const result = await recognizeWithBestEngine(await canvasToBlob(canvas), (fraction, stage) =>
          onProgress(0.18 + ((pageNumber - 1 + fraction) / pageCount) * 0.72, stage)
        )
        ocrPages.push(result.text)
        if (result.recognition === 'local-ai') {
          recognition = 'local-ai'
          backend = result.backend
        } else if (recognition !== 'local-ai') {
          recognition = result.recognition
          backend = result.backend
        }
      }
      extractedText = ocrPages.join('\n')
    } else {
      recognition = 'pdf-text'
      backend = 'PDF-Text mit Positionsdaten'
    }
  } else if (file.type.startsWith('image/')) {
    onProgress(0.04, 'Bild wird vorbereitet')
    const result = await recognizeWithBestEngine(file, onProgress)
    extractedText = result.text
    recognition = result.recognition
    backend = result.backend
  } else {
    throw new Error('Bitte lade eine PDF-Datei oder ein Bild (JPG, PNG, WebP) hoch.')
  }

  onProgress(1, 'Auswertung abgeschlossen')
  if (!extractedText.trim()) throw new Error('Es wurde kein lesbarer Text gefunden. Bitte fotografiere den Beleg möglichst scharf und gerade.')
  return parseInvoiceText(extractedText, recognition, backend)
}
