export type InvoiceExtraction = {
  text: string
  name: string
  amount: number | null
  date: string
  quantity: number
}

function parseEuro(value: string): number | null {
  const normalized = value.replace(/[€\s]/g, '').replace(/\.(?=\d{3}(?:,|$))/g, '').replace(',', '.')
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseInvoiceText(rawText: string): InvoiceExtraction {
  const text = rawText.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ')
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)

  const amountPattern = /(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})|\d+[,.]\d{2})\s*(?:€|EUR)?/g
  let amount: number | null = null
  const amountPriority = /(gesamtbetrag|rechnungsbetrag|endbetrag|zu zahlen|zahlbetrag|summe|total|brutto)/i
  for (const line of lines) {
    if (!amountPriority.test(line)) continue
    const matches = [...line.matchAll(amountPattern)]
    if (matches.length) {
      amount = parseEuro(matches[matches.length - 1][1])
      if (amount !== null) break
    }
  }
  if (amount === null) {
    const values = lines.flatMap(line => [...line.matchAll(amountPattern)].map(match => parseEuro(match[1])))
      .filter((value): value is number => value !== null && value > 0 && value < 100000)
    amount = values.length ? Math.max(...values) : null
  }

  const dateMatch = text.match(/\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](20\d{2})\b/)
  const date = dateMatch
    ? dateMatch[3] + '-' + dateMatch[2].padStart(2, '0') + '-' + dateMatch[1].padStart(2, '0')
    : ''

  let name = ''
  const headingIndex = lines.findIndex(line => /(artikel|beschreibung|produkt|bezeichnung|waren)/i.test(line))
  const candidates = headingIndex >= 0 ? lines.slice(headingIndex + 1, headingIndex + 6) : lines.slice(0, 16)
  const excluded = /^(rechnung|quittung|kassenbon|beleg|datum|uhrzeit|rechnungsnummer|kundennummer|steuer|ust|mwst|gesamt|zwischen|summe|betrag|bar|ec\b|visa|mastercard|pos\b|artikel\b|menge\b|preis\b|netto|brutto|tel|fax|www\.|https?:|e-?mail)/i
  const useful = candidates.filter(line => line.length >= 4 && line.length <= 100 && /[A-Za-zÄÖÜäöüß]/.test(line) && !excluded.test(line) && !amountPriority.test(line))
  name = useful.sort((a, b) => {
    const aScore = (/[A-Za-zÄÖÜäöüß]{3,}/.test(a) ? 3 : 0) + (/\d/.test(a) ? 1 : 0) - (a.length > 75 ? 3 : 0)
    const bScore = (/[A-Za-zÄÖÜäöüß]{3,}/.test(b) ? 3 : 0) + (/\d/.test(b) ? 1 : 0) - (b.length > 75 ? 3 : 0)
    return bScore - aScore
  })[0] || ''

  const quantityMatch = text.match(/\b([1-9]\d?)\s*(?:x|stk\.?|stück|pcs?)\b/i)
  const quantity = quantityMatch ? Number(quantityMatch[1]) : 1

  return { text, name, amount, date, quantity }
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

export async function readInvoiceFile(
  file: File,
  onProgress: (value: number, stage: string) => void,
): Promise<InvoiceExtraction> {
  const maxSize = 10 * 1024 * 1024
  if (file.size > maxSize) throw new Error('Die Datei ist größer als 10 MB. Bitte wähle eine kleinere Datei.')
  let extractedText = ''

  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    onProgress(0.05, 'PDF wird geöffnet')
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    const pageTexts: string[] = []
    const pageCount = Math.min(pdf.numPages, 8)
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      onProgress(0.08 + (pageNumber / pageCount) * 0.32, 'PDF-Text wird gelesen')
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const pageText = content.items.map(item => ('str' in item ? item.str : '')).join(' ')
      pageTexts.push(pageText)
    }
    extractedText = pageTexts.join('\n')
    if (extractedText.replace(/\s/g, '').length < 25) {
      const ocrPages: string[] = []
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        onProgress(0.42 + (pageNumber / pageCount) * 0.45, 'Gescannte Seite wird erkannt')
        const page = await pdf.getPage(pageNumber)
        const viewport = page.getViewport({ scale: 1.7 })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) continue
        await page.render({ canvas, canvasContext: context, viewport }).promise
        ocrPages.push(await recognizeCanvas(canvas, value => onProgress(0.42 + (pageNumber - 1 + value) / pageCount * 0.45, 'Texterkennung läuft')))
      }
      extractedText = ocrPages.join('\n')
    }
  } else if (file.type.startsWith('image/')) {
    onProgress(0.12, 'Bild wird vorbereitet')
    const imageUrl = URL.createObjectURL(file)
    try {
      const image = new Image()
      image.src = imageUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      const scale = Math.min(2, 2200 / Math.max(image.naturalWidth, image.naturalHeight))
      canvas.width = Math.round(image.naturalWidth * scale)
      canvas.height = Math.round(image.naturalHeight * scale)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Das Bild konnte nicht verarbeitet werden.')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      extractedText = await recognizeCanvas(canvas, value => onProgress(value, 'Texterkennung läuft'))
    } finally {
      URL.revokeObjectURL(imageUrl)
    }
  } else {
    throw new Error('Bitte lade eine PDF-Datei oder ein Bild (JPG, PNG, WebP) hoch.')
  }

  onProgress(1, 'Auswertung abgeschlossen')
  if (!extractedText.trim()) throw new Error('Es wurde kein lesbarer Text gefunden. Bitte fotografiere den Beleg möglichst scharf und gerade.')
  return parseInvoiceText(extractedText)
}
