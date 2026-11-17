import PostalMime from 'postal-mime'
import { parseInvoiceText, readInvoiceFile, type InvoiceExtraction } from './invoiceScanner.ts'

type Progress = (value: number, stage: string) => void

type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>

const MAX_EMAIL_SIZE = 15 * 1024 * 1024
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024

function htmlInvoiceText(html: string): string {
  if (typeof DOMParser === 'undefined') return html
    .replace(/<\/(?:td|th)\s*>/gi, ' | ')
    .replace(/<\/(?:tr|p|div)\s*>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script,style,noscript,svg,iframe,form,button,nav,footer,header').forEach(node => node.remove())
  const tableRows = Array.from(document.querySelectorAll('tr'))
    .map(row => Array.from(row.querySelectorAll('th,td'))
      .map(cell => (cell.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' | '))
    .filter(Boolean)
  document.querySelectorAll('table').forEach(node => node.remove())
  const bodyText = (document.body?.innerText || document.body?.textContent || '')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return [...tableRows, bodyText].filter(Boolean).join('\n')
}

function emailBodyText(email: ParsedEmail): string {
  const subject = email.subject?.trim() || ''
  const html = typeof email.html === 'string' ? htmlInvoiceText(email.html) : ''
  const text = typeof email.text === 'string' ? email.text.trim() : ''
  const body = html.length > text.length * 0.6 ? html : text || html
  return [subject ? 'Betreff: ' + subject : '', body].filter(Boolean).join('\n')
}

function rawSinglePartBody(rawEmail: string): string {
  const separator = /\r?\n\r?\n/
  const match = separator.exec(rawEmail)
  if (!match || match.index === undefined) return ''
  const headers = rawEmail.slice(0, match.index)
  const contentType = headers.match(/^content-type:\s*([^;\r\n]+)/im)?.[1]?.trim().toLowerCase()
  // Multipart and encoded bodies must be decoded by PostalMime, not guessed here.
  if (contentType?.startsWith('multipart/') || !['text/plain', 'text/html'].includes(contentType || '')) return ''
  if (/^content-transfer-encoding:\s*(?:base64|quoted-printable)/im.test(headers)) return ''
  const body = rawEmail.slice(match.index + match[0].length).trim()
  return contentType === 'text/html' ? htmlInvoiceText(body) : body
}

function normalizeEmailInvoiceLabels(text: string): string {
  return text.split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:artikel|produkt|item|description|bezeichnung)\s*[:|]\s*/i, ''))
    .join('\n')
}

function attachmentFile(attachment: ParsedEmail['attachments'][number], index: number): File | null {
  const mime = (attachment.mimeType || '').toLowerCase()
  const filename = attachment.filename?.trim() || 'E-Mail-Anhang-' + (index + 1)
  const extension = filename.toLowerCase().split('.').pop() || ''
  const supported = mime === 'application/pdf' || mime.startsWith('image/') ||
    ['pdf', 'jpg', 'jpeg', 'png', 'webp'].includes(extension)
  if (!supported || !attachment.content || typeof attachment.content === 'string') return null
  const content = attachment.content as ArrayBuffer
  if (content.byteLength === 0 || content.byteLength > MAX_ATTACHMENT_SIZE) return null
  const type = mime || (extension === 'pdf' ? 'application/pdf' : 'image/' + (extension === 'jpg' ? 'jpeg' : extension))
  return new File([content], filename, { type })
}

function candidateScore(result: InvoiceExtraction): number {
  if (!result.lineItems.length) return -1
  const average = result.lineItems.reduce((sum, line) => sum + line.confidence, 0) / result.lineItems.length
  const hasTotal = result.amount !== null && result.amount > 0
  const hasDate = Boolean(result.date)
  return result.lineItems.length * 2 + average + (hasTotal ? 0.7 : 0) + (hasDate ? 0.2 : 0)
}

/**
 * One source adapter for physical receipts, PDFs and saved RFC822 email files.
 * E-mail attachments are evaluated as independent invoices before the email body.
 */
export async function readInvoiceSource(file: File, onProgress: Progress): Promise<InvoiceExtraction> {
  const name = file.name.toLowerCase()
  const isEmail = name.endsWith('.eml') || file.type === 'message/rfc822'
  if (!isEmail) return readInvoiceFile(file, onProgress)
  if (file.size > MAX_EMAIL_SIZE) throw new Error('Die E-Mail ist größer als 15 MB.')

  onProgress(0.04, 'E-Mail und MIME-Anhänge werden lokal gelesen')
  const email = await PostalMime.parse(await file.arrayBuffer(), {
    attachmentEncoding: 'arraybuffer',
    maxPartCount: 250,
    maxNestingDepth: 20,
  })

  const candidates: Array<{ result: InvoiceExtraction; score: number; label: string }> = []
  const attachments = email.attachments || []
  const usable = attachments.flatMap((attachment, index) => {
    const invoiceFile = attachmentFile(attachment, index)
    return invoiceFile ? [{ attachment, file: invoiceFile }] : []
  })

  for (let index = 0; index < usable.length; index++) {
    const entry = usable[index]
    onProgress(0.12 + (index / Math.max(1, usable.length)) * 0.68,
      'Rechnungsanhang wird analysiert: ' + entry.file.name)
    try {
      const result = await readInvoiceFile(entry.file, (fraction, stage) =>
        onProgress(0.12 + ((index + fraction) / Math.max(1, usable.length)) * 0.68, stage)
      )
      candidates.push({
        result: {
          ...result,
          backend: 'E-Mail-Anhang ' + entry.file.name + ' · ' + result.backend,
        },
        score: candidateScore(result) + (entry.file.type === 'application/pdf' ? 0.25 : 0),
        label: entry.file.name,
      })
    } catch {
      // Ignore non-invoice attachments; evaluate other attachments and the body.
    }
  }

  const parsedBody = emailBodyText(email)
  const rawFallback = rawSinglePartBody(await file.text())
  const bodySources = [
    { text: parsedBody, label: 'E-Mail-Text/HTML' },
    { text: rawFallback, label: 'E-Mail-Text-Fallback' },
  ].filter(source => source.text.trim())

  for (const source of bodySources) {
    const bodyText = normalizeEmailInvoiceLabels(source.text)
    const bodyResult = parseInvoiceText(bodyText, 'pdf-text', 'E-Mail-Text/HTML ohne externen KI-Dienst')
    candidates.push({
      result: {
        ...bodyResult,
        date: bodyResult.date || (email.date ? new Date(email.date).toISOString().slice(0, 10) : ''),
        backend: source.label,
      },
      score: candidateScore(bodyResult),
      label: source.label,
    })
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0]
  if (!best || best.score < 0) {
    throw new Error('In der E-Mail wurde keine eindeutige Artikelposition gefunden. Es wurden Anhänge und E-Mail-Text geprüft.')
  }

  onProgress(1, 'E-Mail-Rechnung erkannt: ' + best.label)
  return best.result
}
