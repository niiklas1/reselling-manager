import { recognizeInvoiceWithAI, type FlorenceOcrResult } from './invoiceAi'

export type InvoiceLineItem = {
  id: string
  description: string
  quantity: number
  unitPrice: number | null
  amount: number
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
  let normalized = value.replace(/[€\s]/g, '').replace(/[^\d,.-]/g, '')
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

function parseMoneyMatches(line: string): Array<{ value: number; index: number }> {
  const pattern = /(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{2}/g
  return [...line.matchAll(pattern)].flatMap(match => {
    const value = parseEuro(match[0])
    return value === null ? [] : [{ value, index: match.index ?? 0 }]
  })
}

function parseLineItems(lines: string[]): InvoiceLineItem[] {
  // Be deliberately conservative: only keep rows that look like actual merchandise,
  // not payment details, totals, contact information, or receipt metadata.
  const excluded = /\\b(gesamtbetrag|rechnungsbetrag|endbetrag|zu zahlen|zahlbetrag|zwischensumme|summe|total|brutto|netto|mwst|ust\\.?|mehrwertsteuer|steuerbetrag|rückgeld|gegeben|kartenzahlung|barzahlung|ec[- ]?karte|kreditkarte|visa|mastercard|paypal|zahlung|bezahlt|gutschein|rabatt|versandkosten|lieferkosten|porto|pfand|kaution|anzahlung|gebühr|gebuehr|transaktionsnummer|autorisierung|terminal|kasse|bonnummer|belegnummer|rechnungsnummer|kundennummer|bestellnummer|auftragsnummer|lieferant|rechnung|quittung|kassenbon|datum|uhrzeit|telefon|tel\\.?|fax|email|e-mail|www\\.|http|iban|bic|filiale|straße|str\\.?|plz|adresse|kontakt|seite \\d|seite von)/i
  const result: InvoiceLineItem[] = []
  for (const line of lines) {
    if (excluded.test(line)) continue
    const prices = parseMoneyMatches(line)
    if (!prices.length) continue

    const firstPrice = prices[0]
    let description = line.slice(0, firstPrice.index)
      .replace(/^\\s*(?:\\d{1,3}[.)]\\s*|\\d{1,3}\\s*[x×]\\s*)/i, '')
      .replace(/[|:;–-]+$/g, '')
      .replace(/\\s+/g, ' ')
      .trim()

    // Product titles need readable words; this rejects stray totals, codes and OCR fragments.
    const words = description.match(/[A-Za-zÄÖÜäöüß]{2,}/g) || []
    const letters = (description.match(/[A-Za-zÄÖÜäöüß]/g) || []).length
    const digits = (description.match(/\\d/g) || []).length
    if (description.length < 3 || words.length === 0 || letters < 3) continue
    if (digits > letters * 1.5) continue
    if (/^(?:pos(?:ition)?|art(?:ikel)?(?:-?nr)?|sku|ean|barcode|nr\\.?|id)\\b/i.test(description)) continue
    if (/^[A-Z0-9/_-]{2,18}$/i.test(description) && !/\\s/.test(description)) continue

    const quantityMatch = line.match(/\\b(\\d{1,3})\\s*(?:x|×|stk\\.?|stück|pcs?)\\b/i)
    const quantity = quantityMatch ? Math.max(1, Number(quantityMatch[1])) : 1
    const amount = prices[prices.length - 1].value
    const unitPrice = prices.length > 1 ? prices[prices.length - 2].value : quantity > 1 ? amount : null
    const lineAmount = quantity > 1 && prices.length === 1 ? amount * quantity : amount
    if (!Number.isFinite(lineAmount) || lineAmount <= 0 || lineAmount > 100000) continue

    // The description should be a merchandise name, not a long mixed OCR row.
    if (description.length > 100 || words.length > 12) continue
    result.push({ id: 'line-' + (result.length + 1), description, quantity, unitPrice, amount: Number(lineAmount.toFixed(2)) })
  }
  return result
}

function parseTotal(text: string): number | null {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const priority = /(gesamtbetrag|rechnungsbetrag|endbetrag|zu zahlen|zahlbetrag|summe|total|brutto)/i
  for (const line of lines) {
    if (!priority.test(line)) continue
    const values = parseMoneyMatches(line)
    if (values.length) return values[values.length - 1].value
  }
  return null
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
  const fallbackAmounts = lines.flatMap(line => parseMoneyMatches(line).map(match => match.value))
  const amount = total ?? (lineItems.length ? lineItems.reduce((sum, item) => sum + item.amount, 0) : fallbackAmounts.length ? Math.max(...fallbackAmounts) : null)
  const dateMatch = text.match(/\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](20\d{2})\b/)
  const date = dateMatch
    ? dateMatch[3] + '-' + dateMatch[2].padStart(2, '0') + '-' + dateMatch[1].padStart(2, '0')
    : ''
  // Never guess a product name from arbitrary receipt text. If no clear item row
  // was found, ask the user to enter the name manually instead.
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
    const result = await worker.recognize(canvas)
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
