import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine, ArrowUpRight, Bell, Box, ChartNoAxesCombined, ChevronDown,
  CircleHelp, LayoutDashboard, Menu, Package, Plus, Search, Settings,
  ShoppingBag, SlidersHorizontal, Sparkles, Wallet, X, Trash2, Pencil,
  CalendarDays, Tag, Truck, CheckCircle2, LoaderCircle, DollarSign,
  Camera, FileText, FileUp, ImagePlus, Moon, Sun, ExternalLink, RefreshCw, HardDrive
} from 'lucide-react'
import { readInvoiceFile, type InvoiceLineItem } from './lib/invoiceScanner'
import { googleImagesUrl, searchProductImages, type ProductImageResult } from './lib/productImages'

type Status = 'Auf Lager' | 'Verkauft'
type Product = {
  id: string
  groupId?: string
  name: string
  category: string
  platform: string
  purchasePrice: number
  salePrice: number
  shipping: number
  fees: number
  purchaseDate: string
  saleDate: string
  status: Status
  quantity: number
  imageUrl: string
  imageAttribution: string
  imageLicense: string
  receiptPath: string
}
type Section = 'Übersicht' | 'Produkte' | 'Verkäufe' | 'Auswertungen' | 'Einstellungen'

type InvoiceDraftLine = InvoiceLineItem & {
  selected: boolean
  imageUrl: string
  imageAttribution: string
  imageLicense: string
  imageOptions: ProductImageResult[]
  imageLoading: boolean
  showImageOptions: boolean
}

const PRODUCTS_STORAGE_KEY = 'reselling-products'
const RECEIPTS_DB_NAME = 'reselling-manager-local'
const RECEIPTS_STORE = 'receipts'

let activeCurrency = 'EUR'
const money = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: activeCurrency }).format(value)
const profit = (p: Product) => p.salePrice - p.purchasePrice - p.shipping - p.fees

function splitMoneyAmount(total: number, count: number): number[] {
  const safeCount = Math.max(1, Math.floor(count))
  const cents = Math.round(total * 100)
  const base = Math.trunc(cents / safeCount)
  const remainder = cents - base * safeCount
  return Array.from({ length: safeCount }, (_, index) => (base + (index < Math.abs(remainder) ? Math.sign(remainder) : 0)) / 100)
}

function normalizeProductUnits(records: Array<Partial<Product>>): Product[] {
  const units: Product[] = []
  for (const item of records) {
    const id = typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID()
    const count = Math.max(1, Math.min(10000, Math.floor(Number(item.quantity || 1)) || 1))
    const groupId = typeof item.groupId === 'string' && item.groupId ? item.groupId : id
    const purchasePrice = Number(item.purchasePrice || 0)
    const salePrice = Number(item.salePrice || 0)
    const shipping = Number(item.shipping || 0)
    const fees = Number(item.fees || 0)
    const common = {
      groupId,
      name: item.name || '',
      category: item.category || '',
      platform: item.platform || '',
      purchaseDate: item.purchaseDate || '',
      saleDate: item.saleDate || '',
      status: item.status === 'Verkauft' ? 'Verkauft' as Status : 'Auf Lager' as Status,
      imageUrl: item.imageUrl || '',
      imageAttribution: item.imageAttribution || '',
      imageLicense: item.imageLicense || '',
      receiptPath: typeof item.receiptPath === 'string' ? item.receiptPath : '',
      quantity: 1,
    }
    if (count === 1) {
      units.push({ id, ...common, purchasePrice, salePrice, shipping, fees })
      continue
    }
    // Legacy records stored totals alongside quantity. Split to cents and distribute
    // any remainder so the sum of the new unit values remains exactly the old total.
    const purchaseParts = splitMoneyAmount(purchasePrice, count)
    const saleParts = splitMoneyAmount(salePrice, count)
    const shippingParts = splitMoneyAmount(shipping, count)
    const feeParts = splitMoneyAmount(fees, count)
    for (let index = 0; index < count; index++) {
      units.push({
        id: index === 0 ? id : crypto.randomUUID(),
        ...common,
        purchasePrice: purchaseParts[index],
        salePrice: saleParts[index],
        shipping: shippingParts[index],
        fees: feeParts[index],
      })
    }
  }
  return units
}

function readStoredProducts(): Product[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PRODUCTS_STORAGE_KEY) || '[]')
    if (!Array.isArray(stored)) return []
    return normalizeProductUnits(stored as Array<Partial<Product>>)
  } catch {
    return []
  }
}

function openReceiptsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECEIPTS_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECEIPTS_STORE)) {
        request.result.createObjectStore(RECEIPTS_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Lokaler Belegspeicher konnte nicht geöffnet werden.'))
  })
}

async function saveLocalReceipt(file: File): Promise<string> {
  const db = await openReceiptsDb()
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECEIPTS_STORE, 'readwrite')
    transaction.objectStore(RECEIPTS_STORE).put(file, id)
    transaction.oncomplete = () => { db.close(); resolve('local:' + id) }
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error('Beleg konnte nicht lokal gespeichert werden.')) }
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Speichern des Belegs wurde abgebrochen.')) }
  })
}

async function readLocalReceipt(path: string): Promise<Blob | null> {
  if (!path.startsWith('local:')) return null
  const db = await openReceiptsDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(RECEIPTS_STORE, 'readonly').objectStore(RECEIPTS_STORE).get(path.slice(6))
    request.onsuccess = () => { db.close(); resolve((request.result as Blob) || null) }
    request.onerror = () => { db.close(); reject(request.error || new Error('Beleg konnte nicht gelesen werden.')) }
  })
}

type LocalReceiptRecord = { id: string; blob: Blob; name: string; lastModified: number }

async function readAllLocalReceipts(): Promise<LocalReceiptRecord[]> {
  const db = await openReceiptsDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECEIPTS_STORE, 'readonly')
    const store = transaction.objectStore(RECEIPTS_STORE)
    const keysRequest = store.getAllKeys()
    const valuesRequest = store.getAll()
    transaction.oncomplete = () => {
      try {
        const keys = keysRequest.result
        const values = valuesRequest.result
        if (keys.length !== values.length) throw new Error('Der Belegspeicher konnte nicht vollständig gelesen werden.')
        const records = keys.map((key, index) => {
          const blob = values[index]
          if (typeof key !== 'string' || !(blob instanceof Blob)) throw new Error('Der Belegspeicher enthält einen Datensatz in einem unbekannten Format.')
          const file = typeof File !== 'undefined' && blob instanceof File ? blob : null
          return { id: key, blob, name: file?.name || ('beleg-' + (index + 1)), lastModified: file?.lastModified || Date.now() }
        })
        db.close()
        resolve(records)
      } catch (error) {
        db.close()
        reject(error)
      }
    }
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error('Der Belegspeicher konnte nicht gelesen werden.')) }
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Das Lesen des Belegspeichers wurde abgebrochen.')) }
  })
}

async function removeLocalReceiptsExcept(keepIds: string[]): Promise<void> {
  const keep = new Set(keepIds)
  const db = await openReceiptsDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECEIPTS_STORE, 'readwrite')
    const store = transaction.objectStore(RECEIPTS_STORE)
    const keysRequest = store.getAllKeys()
    keysRequest.onsuccess = () => {
      for (const key of keysRequest.result) {
        if (typeof key === 'string' && !keep.has(key)) store.delete(key)
      }
    }
    transaction.oncomplete = () => { db.close(); resolve() }
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error('Alte Belege konnten nicht bereinigt werden.')) }
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Die Bereinigung wurde abgebrochen.')) }
  })
}

async function deleteLocalReceipt(path: string): Promise<void> {
  if (!path.startsWith('local:')) return
  const db = await openReceiptsDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECEIPTS_STORE, 'readwrite')
    transaction.objectStore(RECEIPTS_STORE).delete(path.slice(6))
    transaction.oncomplete = () => { db.close(); resolve() }
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error('Beleg konnte nicht gelöscht werden.')) }
  })
}


type BackupReceipt = { name: string; type: string; data: string }
type ResellingBackupV1 = { format: 'reselling-manager-backup'; version: 1; createdAt: string; products: Product[]; receipts: Record<string, BackupReceipt> }
type ResellingBackupV2 = { format: 'reselling-manager-backup'; version: 2; createdAt: string; products: Product[] }
type BackupReceiptV3 = { id: string; archivePath: string; name: string; type: string; lastModified: number }
type ResellingBackupV3 = {
  format: 'reselling-manager-backup'
  version: 3
  createdAt: string
  products: Product[]
  localStorage: Record<string, string>
  receipts: BackupReceiptV3[]
}
type ZipEntry = { name: string; bytes: Uint8Array }

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder()
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.bytes)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, 0, true); lv.setUint32(14, crc, true); lv.setUint32(18, entry.bytes.length, true); lv.setUint32(22, entry.bytes.length, true); lv.setUint16(26, name.length, true)
    local.set(name, 30); localParts.push(local, entry.bytes)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true); cv.setUint32(16, crc, true); cv.setUint32(20, entry.bytes.length, true); cv.setUint32(24, entry.bytes.length, true)
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46)
    centralParts.push(central); offset += local.length + entry.bytes.length
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22); const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true)
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' })
}

function readZipBytes(bytes: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const files: Record<string, Uint8Array> = {}
  let offset = 0
  let entryCount = 0
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true)
    const method = view.getUint16(offset + 8, true)
    const expectedCrc = view.getUint32(offset + 14, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const uncompressedSize = view.getUint32(offset + 22, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    if ((flags & 0x0009) !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error('Dieses ZIP-Backup verwendet ein nicht unterstütztes Kompressionsformat.')
    }
    const nameStart = offset + 30
    const nameEnd = nameStart + nameLength
    const name = decoder.decode(bytes.slice(nameStart, nameEnd))
    const dataStart = nameEnd + extraLength
    const dataEnd = dataStart + compressedSize
    if (!name || dataEnd > bytes.length || dataStart < nameEnd) throw new Error('Die Backup-Datei ist beschädigt oder unvollständig.')
    if (Object.prototype.hasOwnProperty.call(files, name)) throw new Error('Die Backup-Datei enthält doppelte Dateieinträge.')
    const data = bytes.slice(dataStart, dataEnd)
    if (crc32(data) !== expectedCrc) throw new Error('Die Backup-Datei ist beschädigt: Eine Prüfsumme stimmt nicht.')
    files[name] = data
    offset = dataEnd
    entryCount++
    if (entryCount > 10000) throw new Error('Das Backup enthält ungewöhnlich viele Dateien.')
  }
  if (!files['backup.json']) throw new Error('In der Datei wurde keine gültige backup.json gefunden.')
  return files
}

async function readZip(file: File): Promise<Record<string, Uint8Array>> {
  return readZipBytes(new Uint8Array(await file.arrayBuffer()))
}

async function extractZipFromPdf(file: File): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib')
  const pdf = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()))
  const attachments = await pdf.getAttachments()
  const backupAttachment = attachments.find((attachment: { name: string }) =>
    attachment.name === 'reselling-manager-backup.zip'
  )
  if (!backupAttachment) {
    throw new Error('In dieser PDF wurde kein vollständiges Reselling-Manager-Backup gefunden. Verwende bitte die unveränderte Original-PDF.')
  }
  return new Uint8Array(backupAttachment.data)
}

function pdfSafeText(value: string): string {
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/€/g, ' EUR ')
    .replace(/£/g, ' GBP ')
    .replace(/[–—•·]/g, '-')
    .replace(/[^\x20-\x7E]/g, '?')
}

async function createBackupPdf(archive: Blob, products: Product[], receiptCount: number): Promise<File> {
  const { PDFDocument, StandardFonts, rgb } = await import('@cantoo/pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.setTitle('Reselling Manager - Vollstaendiges Backup')
  pdf.setSubject('Vollstaendige Datensicherung inklusive Originalbelege')
  pdf.setCreator('Reselling Manager')
  pdf.setCreationDate(new Date())
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pageSize: [number, number] = [595.28, 841.89]
  const margin = 46
  const maxWidth = pageSize[0] - margin * 2
  const ink = rgb(0.12, 0.15, 0.22)
  const muted = rgb(0.38, 0.42, 0.49)
  const accent = rgb(0.25, 0.32, 0.75)
  let page = pdf.addPage(pageSize)
  let y = 790

  const addPage = () => { page = pdf.addPage(pageSize); y = 790 }
  const write = (raw: string, size = 9, font = regular, color = ink, indent = 0) => {
    const text = pdfSafeText(raw)
    const words = text.split(/\s+/).filter(Boolean)
    const lineHeight = size + 4
    let line = ''
    const draw = (value: string) => {
      if (y < 54 + lineHeight) addPage()
      page.drawText(value, { x: margin + indent, y, size, font, color })
      y -= lineHeight
    }
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth - indent) {
        draw(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (line) draw(line)
  }
  const gap = (amount = 6) => { y -= amount; if (y < 58) addPage() }

  write('RESELLING MANAGER', 9, bold, accent)
  gap(15)
  write('Vollstaendiges Backup', 23, bold, ink)
  write('Sicherung erstellt am: ' + new Date().toLocaleString('de-DE'), 9, regular, muted)
  gap(18)
  write('Dieses PDF enthaelt eine eingebettete Wiederherstellungsdatei. Zum Wiederherstellen dieses PDF in der Website unter Einstellungen > Backup hochladen auswaehlen.', 10, bold)
  gap(12)
  write('INHALT DER SICHERUNG', 10, bold, accent)
  write('Produkte: ' + products.length)
  write('Originalbelege im lokalen Belegspeicher: ' + receiptCount)
  write('Gespeicherte Produktdaten, Verkaufsdaten, Kosten, Mengen, Kategorien, Plattformen und Bildquellen')
  write('Alle gespeicherten Website-Einstellungen und lokale Speicherwerte')
  gap(18)
  write('PRODUKTUEBERSICHT', 11, bold, accent)
  if (products.length === 0) write('Es waren keine Produkte gespeichert.')
  for (const [index, product] of products.entries()) {
    gap(4)
    write((index + 1) + '. ' + (product.name || 'Unbenanntes Produkt') + ' - ' + product.status, 10, bold)
    write('Kategorie: ' + (product.category || '-') + ' | Plattform: ' + (product.platform || '-') + ' | Menge: ' + (product.quantity || 1))
    write('Einkauf: ' + money(product.purchasePrice) + ' | Verkauf: ' + money(product.salePrice) + ' | Versand: ' + money(product.shipping) + ' | Gebuehren: ' + money(product.fees))
    write('Kaufdatum: ' + (product.purchaseDate || '-') + ' | Verkaufsdatum: ' + (product.saleDate || '-'))
  }
  gap(18)
  write('WICHTIG: Die Wiederherstellungsdatei liegt als PDF-Anhang mit dem Namen reselling-manager-backup.zip in diesem Dokument. Bitte dieses PDF unveraendert in Dateien sichern und beim Import wieder auswaehlen. Nicht drucken oder ueber einen PDF-Editor neu exportieren.', 9, bold)
  await pdf.attach(new Uint8Array(await archive.arrayBuffer()), 'reselling-manager-backup.zip', {
    mimeType: 'application/zip',
    description: 'Vollstaendige Wiederherstellungsdatei mit Produktdaten, Website-Einstellungen und Originalbelegen.',
    creationDate: new Date(),
    modificationDate: new Date(),
  })
  const bytes = await pdf.save()
  const fileName = 'reselling-manager-backup-' + new Date().toISOString().slice(0, 10) + '.pdf'
  return new File([bytes], fileName, { type: 'application/pdf' })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Ein Beleg konnte nicht für das Backup gelesen werden.'))
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Die Backup-Datei enthält einen ungültigen Beleg.')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: match[1] || 'application/octet-stream' })
}

function App() {
  const [section, setSection] = useState<Section>('Übersicht')
  const [dataError, setDataError] = useState('')
  const [products, setProducts] = useState<Product[]>(readStoredProducts())
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'Alle' | Status>('Alle')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [selling, setSelling] = useState<Product | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [pendingBackupFile, setPendingBackupFile] = useState<File | null>(null)
  const [currency, setCurrency] = useState(() => localStorage.getItem('reselling-currency') || 'EUR')
  const [receiptProduct, setReceiptProduct] = useState<Product | null>(null)
  const [backupMessage, setBackupMessage] = useState('')
  const backupInput = useRef<HTMLInputElement>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('reselling-theme')
    return saved === 'light' ? 'light' : 'dark'
  })

  activeCurrency = currency

  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => false)
  }, [])

  useEffect(() => {
    localStorage.setItem('reselling-currency', currency)
    activeCurrency = currency
  }, [currency])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('reselling-theme', theme)
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem(PRODUCTS_STORAGE_KEY, JSON.stringify(products))
    } catch {
      setDataError('Der lokale Speicher ist voll. Entferne große oder nicht mehr benötigte Belege.')
    }
  }, [products])



  async function createBackup() {
    setBackupBusy(true)
    setBackupMessage('')
    try {
      const receipts = await readAllLocalReceipts()
      const entries: ZipEntry[] = []
      const archivePathById = new Map<string, string>()
      const receiptManifest: BackupReceiptV3[] = []
      for (const [index, receipt] of receipts.entries()) {
        const originalExtension = receipt.name.includes('.') ? receipt.name.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '') : ''
        const typeExtension = receipt.blob.type === 'application/pdf' ? 'pdf' : receipt.blob.type.startsWith('image/') ? (receipt.blob.type.split('/')[1] || 'img').replace('jpeg', 'jpg') : ''
        const extension = originalExtension || typeExtension || 'bin'
        const archivePath = 'receipts/receipt-' + (index + 1) + '.' + extension
        archivePathById.set(receipt.id, archivePath)
        receiptManifest.push({ id: receipt.id, archivePath, name: receipt.name, type: receipt.blob.type || 'application/octet-stream', lastModified: receipt.lastModified })
        entries.push({ name: archivePath, bytes: new Uint8Array(await receipt.blob.arrayBuffer()) })
      }

      const backupProducts = products.map(product => {
        if (!product.receiptPath) return { ...product }
        if (!product.receiptPath.startsWith('local:')) throw new Error('Ein Produkt verweist auf einen unbekannten Belegspeicher. Das Backup wurde nicht erstellt, damit keine Daten fehlen.')
        const archivePath = archivePathById.get(product.receiptPath.slice(6))
        if (!archivePath) throw new Error('Ein zugeordneteter Originalbeleg fehlt. Das Backup wurde nicht erstellt, damit es vollständig bleibt.')
        return { ...product, receiptPath: 'backup:' + archivePath }
      })

      const storedValues: Record<string, string> = {}
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key) storedValues[key] = localStorage.getItem(key) ?? ''
      }
      storedValues[PRODUCTS_STORAGE_KEY] = JSON.stringify(backupProducts)
      storedValues['reselling-currency'] = currency
      storedValues['reselling-theme'] = theme

      const manifest: ResellingBackupV3 = {
        format: 'reselling-manager-backup',
        version: 3,
        createdAt: new Date().toISOString(),
        products: backupProducts,
        localStorage: storedValues,
        receipts: receiptManifest,
      }
      entries.unshift({ name: 'backup.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) })
      const archive = makeZip(entries)
      const backupFile = await createBackupPdf(archive, products, receipts.length)
      setPendingBackupFile(backupFile)
      setBackupMessage('PDF-Backup fertig. Tippe jetzt auf „PDF in Dateien sichern“, um das iOS-Teilen-Menü zu öffnen.')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') setBackupMessage('Speichern wurde abgebrochen. Es wurde keine Datei als gesichert bestätigt.')
      else setBackupMessage(error instanceof Error ? error.message : 'PDF-Backup konnte nicht erstellt werden.')
    } finally {
      setBackupBusy(false)
    }
  }

  async function shareBackupFile() {
    const file = pendingBackupFile
    if (!file) return
    if (!navigator.share || typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) {
      setBackupMessage('Teilen von Dateien wird in diesem Browser nicht unterstützt. Nutze „PDF herunterladen“ und anschließend das Teilen-Menü der PDF in Safari.')
      return
    }
    try {
      // navigator.share must be invoked immediately in the tap handler, before any await.
      const shareResult = navigator.share({ files: [file], title: 'Reselling Manager Backup' })
      await shareResult
      setBackupMessage('Teilen-Menü geschlossen. Wähle dort „In Dateien sichern“, wenn du die PDF ablegen möchtest.')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') setBackupMessage('Teilen abgebrochen. Die fertige PDF bleibt hier bereit.')
      else setBackupMessage('Das Teilen-Menü konnte nicht geöffnet werden. Nutze alternativ „PDF herunterladen“.')
    }
  }

  function downloadBackupFile() {
    if (!pendingBackupFile) return
    const url = URL.createObjectURL(pendingBackupFile)
    const link = document.createElement('a')
    link.href = url
    link.download = pendingBackupFile.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60000)
    setBackupMessage('PDF-Download wurde gestartet. Auf dem iPhone kannst du die Datei anschließend in Safari über Teilen > In Dateien sichern ablegen.')
  }

  async function restoreBackup(file?: File) {
    if (!file) return
    setBackupBusy(true)
    setBackupMessage('')
    const createdPaths: string[] = []
    let restoreCommitted = false
    try {
      let restoredProducts: Product[]
      const receiptFiles: Record<string, { name: string; type: string; bytes: Uint8Array; lastModified?: number }> = {}
      let storageSnapshot: Record<string, string> | null = null
      const lowerName = file.name.toLowerCase()

      if (lowerName.endsWith('.pdf') || file.type === 'application/pdf') {
        const archiveBytes = await extractZipFromPdf(file)
        const archive = readZipBytes(archiveBytes)
        const manifest = JSON.parse(new TextDecoder().decode(archive['backup.json'])) as Partial<ResellingBackupV3> & { version?: number }
        if (manifest.format !== 'reselling-manager-backup' || !Array.isArray(manifest.products)) throw new Error('Die PDF enthält keine gültigen Reselling-Manager-Produktdaten.')
        if (manifest.version !== 3 || !Array.isArray(manifest.receipts) || !manifest.localStorage || typeof manifest.localStorage !== 'object') {
          throw new Error('Die PDF enthält ein älteres oder unvollständiges Backupformat. Bitte die Original-PDF eines aktuellen Backups verwenden.')
        }
        restoredProducts = manifest.products
        storageSnapshot = manifest.localStorage
        for (const receipt of manifest.receipts) {
          if (!receipt || typeof receipt.archivePath !== 'string' || typeof receipt.name !== 'string' || typeof receipt.type !== 'string') {
            throw new Error('Die PDF enthält einen ungültigen Belegdatensatz.')
          }
          const data = archive[receipt.archivePath]
          if (!data) throw new Error('Ein Originalbeleg fehlt in der PDF. Deine bisherigen Daten bleiben unverändert.')
          receiptFiles[receipt.archivePath] = { name: receipt.name, type: receipt.type, bytes: data, lastModified: receipt.lastModified }
        }
      } else if (lowerName.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
        const archive = await readZip(file)
        const manifestBytes = archive['backup.json']
        if (!manifestBytes) throw new Error('In der ZIP-Datei wurde keine backup.json gefunden.')
        const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Partial<ResellingBackupV3> & { version?: number }
        if (manifest.format !== 'reselling-manager-backup' || !Array.isArray(manifest.products)) throw new Error('Diese ZIP-Datei ist kein gültiges Reselling-Manager-Backup.')
        restoredProducts = manifest.products
        if (manifest.version === 3) {
          if (!Array.isArray(manifest.receipts) || !manifest.localStorage || typeof manifest.localStorage !== 'object') throw new Error('Das Backup enthält unvollständige Speicherinformationen.')
          storageSnapshot = manifest.localStorage
          for (const receipt of manifest.receipts) {
            if (!receipt || typeof receipt.archivePath !== 'string' || typeof receipt.name !== 'string' || typeof receipt.type !== 'string') throw new Error('Das Backup enthält einen ungültigen Belegdatensatz.')
            const data = archive[receipt.archivePath]
            if (!data) throw new Error('Ein Originalbeleg fehlt im Backup. Deine bisherigen Daten bleiben unverändert.')
            receiptFiles[receipt.archivePath] = { name: receipt.name, type: receipt.type, bytes: data, lastModified: receipt.lastModified }
          }
        } else if (manifest.version === 2) {
          for (const product of restoredProducts) {
            const path = typeof product.receiptPath === 'string' && product.receiptPath.startsWith('backup:') ? product.receiptPath.slice(7) : ''
            if (!path) continue
            const data = archive[path]
            if (!data) throw new Error('Ein zugeordneter Beleg fehlt im Backup. Deine bisherigen Daten bleiben unverändert.')
            const extension = path.split('.').pop()?.toLowerCase() || 'bin'
            const type = extension === 'pdf' ? 'application/pdf' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'application/octet-stream'
            receiptFiles[path] = { name: path.split('/').pop() || 'beleg', type, bytes: data }
          }
        } else {
          throw new Error('Diese ZIP-Datei verwendet eine nicht unterstützte Backup-Version.')
        }
      } else {
        const parsed = JSON.parse(await file.text()) as Partial<ResellingBackupV1>
        if (parsed.format !== 'reselling-manager-backup' || parsed.version !== 1 || !Array.isArray(parsed.products) || !parsed.receipts || typeof parsed.receipts !== 'object') {
          throw new Error('Diese Datei ist weder ein PDF-Backup noch ein gültiges älteres JSON-Backup.')
        }
        restoredProducts = parsed.products
        for (const [path, receipt] of Object.entries(parsed.receipts)) {
          if (!receipt || typeof receipt.data !== 'string' || typeof receipt.name !== 'string' || typeof receipt.type !== 'string') throw new Error('Das JSON-Backup enthält einen beschädigten Beleg.')
          const blob = dataUrlToBlob(receipt.data)
          receiptFiles[path] = { name: receipt.name, type: receipt.type, bytes: new Uint8Array(await blob.arrayBuffer()) }
        }
      }

      if (!restoredProducts.every(product => product && typeof product.id === 'string' && typeof product.name === 'string')) throw new Error('Das Backup enthält ungültige Produktdaten.')
      if (!window.confirm('Das Backup ersetzt alle aktuell gespeicherten Produkte, Einstellungen und Originalbelege. Möchtest du fortfahren?')) return

      const newPaths: Record<string, string> = {}
      for (const [archivePath, receipt] of Object.entries(receiptFiles)) {
        const fileOptions: FilePropertyBag = { type: receipt.type }
        if (typeof receipt.lastModified === 'number' && Number.isFinite(receipt.lastModified)) fileOptions.lastModified = receipt.lastModified
        const path = await saveLocalReceipt(new File([receipt.bytes], receipt.name, fileOptions))
        createdPaths.push(path)
        newPaths[archivePath] = path
      }

      const finalProducts = normalizeProductUnits(restoredProducts.map(product => {
        const oldPath = typeof product.receiptPath === 'string' ? product.receiptPath : ''
        const key = oldPath.startsWith('backup:') ? oldPath.slice(7) : oldPath
        if (key && receiptFiles[key] && !newPaths[key]) throw new Error('Ein Beleg konnte nicht wiederhergestellt werden.')
        if ((oldPath.startsWith('local:') || oldPath.startsWith('backup:')) && !newPaths[key]) throw new Error('Ein Beleg fehlt im Backup. Deine bisherigen Daten bleiben unverändert.')
        return { ...product, receiptPath: newPaths[key] || '' }
      }))

      const previousStorage: Record<string, string> = {}
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key) previousStorage[key] = localStorage.getItem(key) ?? ''
      }
      try {
        if (storageSnapshot) {
          const nextStorage = { ...storageSnapshot, [PRODUCTS_STORAGE_KEY]: JSON.stringify(finalProducts) }
          localStorage.clear()
          for (const [key, value] of Object.entries(nextStorage)) localStorage.setItem(key, value)
        } else {
          localStorage.setItem(PRODUCTS_STORAGE_KEY, JSON.stringify(finalProducts))
        }
      } catch (storageError) {
        localStorage.clear()
        for (const [key, value] of Object.entries(previousStorage)) localStorage.setItem(key, value)
        throw storageError
      }

      if (storageSnapshot) {
        const restoredCurrency = storageSnapshot['reselling-currency']
        const restoredTheme = storageSnapshot['reselling-theme']
        if (restoredCurrency && ['EUR', 'USD', 'GBP', 'CHF'].includes(restoredCurrency)) setCurrency(restoredCurrency)
        if (restoredTheme === 'light' || restoredTheme === 'dark') setTheme(restoredTheme)
      }
      setProducts(finalProducts)
      restoreCommitted = true
      await removeLocalReceiptsExcept(createdPaths.map(path => path.slice(6))).catch(() => undefined)
      setBackupMessage('Wiederherstellung erfolgreich: ' + finalProducts.length + ' Produkte und ' + Object.keys(newPaths).length + ' Originalbelege importiert. Einstellungen wurden ebenfalls übernommen.')
    } catch (error) {
      if (!restoreCommitted) await Promise.all(createdPaths.map(path => deleteLocalReceipt(path).catch(() => undefined)))
      setBackupMessage(error instanceof Error ? error.message : 'Backup konnte nicht wiederhergestellt werden.')
    } finally {
      setBackupBusy(false)
      if (backupInput.current) backupInput.current.value = ''
    }
  }

  const sold = products.filter(p => p.status === 'Verkauft')
  const stock = products.filter(p => p.status === 'Auf Lager')
  const revenue = sold.reduce((sum, p) => sum + p.salePrice, 0)
  const totalProfit = sold.reduce((sum, p) => sum + profit(p), 0)
  const investment = stock.reduce((sum, p) => sum + p.purchasePrice, 0)
  const stockUnits = stock.reduce((sum, p) => sum + (p.quantity || 1), 0)

  const visibleProducts = useMemo(() => products.filter(p => {
    const matchesSearch = [p.name, p.category, p.platform].join(' ').toLowerCase().includes(search.toLowerCase())
    return matchesSearch && (filter === 'Alle' || p.status === filter)
  }), [products, search, filter])

  async function saveProduct(batch: Product[], invoiceFile?: File | null): Promise<boolean> {
    if (batch.length === 0) return false
    setDataError('')
    const previousReceiptPath = editing?.receiptPath || ''
    let receiptPath = batch[0].receiptPath || ''

    try {
      if (invoiceFile) receiptPath = await saveLocalReceipt(invoiceFile)
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Der Beleg konnte nicht lokal gespeichert werden.')
      return false
    }

    const savedRows = batch.map(product => ({ ...product, receiptPath }))
    setProducts(current => editing
      ? current.map(product => product.id === savedRows[0].id ? savedRows[0] : product)
      : [...savedRows, ...current])

    if (previousReceiptPath && previousReceiptPath !== receiptPath &&
        !products.some(product => product.id !== editing?.id && product.receiptPath === previousReceiptPath)) {
      try { await deleteLocalReceipt(previousReceiptPath) } catch { /* Product data remains saved locally. */ }
    }
    setShowForm(false)
    setEditing(null)
    return true
  }

  function editProduct(product: Product) { setEditing(product); setShowForm(true) }
  function saveSale(values: { salePrice: number; shipping: number; fees: number; saleDate: string }) {
    if (!selling) return
    setProducts(current => current.map(item => item.id === selling.id
      ? { ...item, ...values, status: 'Verkauft' as Status }
      : item))
    setSelling(null)
  }
  async function deleteProduct(id: string) {
    if (!window.confirm('Möchtest du dieses Produkt wirklich löschen?')) return
    const productToDelete = products.find(product => product.id === id)
    setProducts(current => current.filter(p => p.id !== id))
    if (productToDelete?.receiptPath && !products.some(product => product.id !== id && product.receiptPath === productToDelete.receiptPath)) {
      try { await deleteLocalReceipt(productToDelete.receiptPath) } catch { setDataError('Produkt gelöscht, der zugehörige Beleg konnte aber nicht entfernt werden.') }
    }
  }
  function openNew() { setEditing(null); setShowForm(true) }

  const navItems: { label: Section; icon: typeof LayoutDashboard }[] = [
    { label: 'Übersicht', icon: LayoutDashboard },
    { label: 'Produkte', icon: Package },
    { label: 'Verkäufe', icon: ShoppingBag },
    { label: 'Auswertungen', icon: ChartNoAxesCombined },
  ]

  return (
    <div className="app-shell">
      <aside className={mobileNav ? 'sidebar sidebar-open' : 'sidebar'}>
        <div className="brand"><div className="brand-symbol">r.</div><span>resell<span className="brand-muted">manager</span></span><button className="mobile-close" onClick={() => setMobileNav(false)}><X size={18}/></button></div>
        <div className="nav-caption">MENÜ</div>
        <nav className="navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={section === label ? 'nav-link selected' : 'nav-link'} onClick={() => { setSection(label); setMobileNav(false) }}>
              <Icon size={18}/><span>{label}</span>{label === 'Produkte' && products.length > 0 && <span className="nav-count">{products.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer"/>
        <button className={section === 'Einstellungen' ? 'nav-link selected' : 'nav-link'} onClick={() => setSection('Einstellungen')}><Settings size={18}/><span>Einstellungen</span></button>
        <button className="profile-card" onClick={() => { setSection(current => current === 'Einstellungen' ? 'Übersicht' : 'Einstellungen'); setMobileNav(false) }} title="Einstellungen öffnen oder schließen"><div className="profile-avatar">N</div><div className="profile-copy"><strong>Mein Workspace</strong><span>Lokales Gerät</span></div><ChevronDown size={15} className="profile-chevron"/></button>
        <div className="sidebar-foot">RESSELLMANAGER <span>·</span> V 0.1</div>
      </aside>

      {mobileNav && <button className="mobile-backdrop" aria-label="Menü schließen" onClick={() => setMobileNav(false)}/>}

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={20}/></button>
          <div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{section}</strong></div>
          <div className="topbar-right"><span className="local-status"><i/> Nur dieses Gerät</span><button className="top-icon" aria-label="Hilfe" title="Hilfe" onClick={() => setShowHelp(true)}><CircleHelp size={18}/></button><button className="theme-toggle" aria-label={theme === 'dark' ? 'Helles Design aktivieren' : 'Dark Mode aktivieren'} title={theme === 'dark' ? 'Helles Design' : 'Dark Mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}</button><button className="top-avatar top-avatar-button" onClick={() => setSection(current => current === 'Einstellungen' ? 'Übersicht' : 'Einstellungen')} title="Einstellungen öffnen oder schließen" aria-expanded={section === 'Einstellungen'}>N</button></div>
        </header>

        <div className="page-wrap">
          {dataError && <div className="app-alert error" role="alert">{dataError}</div>}
          {section === 'Übersicht' && (
            <>
              <div className="page-header"><div><div className="overline">DEIN BUSINESS AUF EINEN BLICK</div><h1>Übersicht</h1><p>Willkommen zurück. Hier ist dein aktueller Überblick.</p></div><button className="button-primary" onClick={openNew}><Plus size={17}/> Produkt hinzufügen</button></div>
              <div className="metric-grid">
                <Metric icon={<Wallet size={19}/>} label="Gesamtgewinn" value={money(totalProfit)} detail="Aus abgeschlossenen Verkäufen" tone="violet"/>
                <Metric icon={<ArrowDownToLine size={19}/>} label="Umsatz" value={money(revenue)} detail="Erzielter Verkaufserlös" tone="blue"/>
                <Metric icon={<Package size={19}/>} label="Aktiver Bestand" value={String(stockUnits)} detail={`${money(investment)} Einkaufspreis im Lager`} tone="amber"/>
                <Metric icon={<CheckCircle2 size={19}/>} label="Verkaufte Produkte" value={String(sold.length)} detail="Erfolgreich abgeschlossen" tone="green"/>
              </div>
              <div className="dashboard-grid">
                <section className="panel performance-panel">
                  <div className="panel-title-row"><div><h2>Deine Performance</h2><p>Umsatz und Gewinn aus deinen Verkäufen</p></div><span className="range-label">GESAMTZEITRAUM</span></div>
                  {sold.length === 0 ? <EmptyState icon={<ChartNoAxesCombined size={22}/>} title="Noch keine Verkaufsdaten" text="Jedes einzelne Exemplar kann separat verkauft werden. Die Übersicht zeigt deine gesamten Kennzahlen."/> : <div className="performance-numbers"><div><span>Umsatz</span><strong>{money(revenue)}</strong></div><div><span>Gewinn</span><strong className={totalProfit >= 0 ? 'positive' : 'negative'}>{money(totalProfit)}</strong></div><div><span>Ø Gewinn / Verkauf</span><strong>{money(totalProfit / sold.length)}</strong></div></div>}
                  <div className="panel-divider"/><div className="mini-legend"><span><i className="legend-blue"/> Umsatz</span><span><i className="legend-violet"/> Gewinn</span></div>
                </section>
                <section className="panel quick-panel"><div className="panel-title-row"><div><h2>Schnellübersicht</h2><p>Deine offenen Bestände</p></div><Box size={18} className="muted-icon"/></div><div className="quick-row"><span>Stück auf Lager</span><strong>{stockUnits}</strong></div><div className="quick-row"><span>Verkaufte Produkte</span><strong>{sold.length}</strong></div><div className="quick-row"><span>Investiertes Kapital</span><strong>{money(investment)}</strong></div><button className="subtle-button" onClick={() => setSection('Produkte')}>Bestand ansehen <ArrowUpRight size={15}/></button></section>
              </div>
              <section className="panel recent-panel"><div className="panel-title-row"><div><h2>Zuletzt hinzugefügt</h2><p>Deine neuesten Produkte</p></div><button className="text-action" onClick={() => setSection('Produkte')}>Alle Produkte ansehen <ArrowUpRight size={14}/></button></div>
                {products.length === 0 ? <EmptyState icon={<Package size={22}/>} title="Dein Reselling startet hier" text="Lege dein erstes Produkt an und behalte Einkauf, Verkauf und Gewinn im Blick." action={<button className="button-secondary" onClick={openNew}><Plus size={15}/> Erstes Produkt anlegen</button>}/> : <ProductTable products={products.slice(0, 5)} onEdit={editProduct} onDelete={deleteProduct} onSell={setSelling} onReceipt={setReceiptProduct}/>}
              </section>
            </>
          )}

          {section === 'Produkte' && (
            <>
              <div className="page-header"><div><div className="overline">INVENTAR VERWALTEN</div><h1>Produkte</h1><p>Verwalte deine Einkäufe, Bestände und Verkäufe.</p></div><button className="button-primary" onClick={openNew}><Plus size={17}/> Produkt hinzufügen</button></div>
              <div className="panel inventory-panel"><div className="inventory-toolbar"><div className="search-box"><Search size={17}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Produkte suchen..."/></div><div className="filter-control"><SlidersHorizontal size={16}/><select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option>Alle</option><option>Auf Lager</option><option>Verkauft</option></select></div></div>
                {visibleProducts.length ? <ProductTable products={visibleProducts} onEdit={editProduct} onDelete={deleteProduct} onSell={setSelling} onReceipt={setReceiptProduct}/> : <EmptyState icon={<Package size={22}/>} title={products.length ? 'Keine Produkte gefunden' : 'Noch keine Produkte vorhanden'} text={products.length ? 'Passe deine Suche oder den Filter an.' : 'Füge dein erstes Produkt hinzu, um deinen Bestand aufzubauen.'} action={!products.length ? <button className="button-secondary" onClick={openNew}><Plus size={15}/> Produkt anlegen</button> : undefined}/>}
              </div>
            </>
          )}

          {section === 'Verkäufe' && (
            <>
              <div className="page-header"><div><div className="overline">ABGESCHLOSSENE TRANSAKTIONEN</div><h1>Verkäufe</h1><p>Behalte Erlöse, Gebühren und tatsächliche Gewinne im Blick.</p></div></div>
              <div className="metric-grid compact-metrics"><Metric icon={<ShoppingBag size={19}/>} label="Verkäufe" value={String(sold.length)} detail="Abgeschlossene Verkäufe" tone="blue"/><Metric icon={<Wallet size={19}/>} label="Umsatz" value={money(revenue)} detail="Vor Abzug der Kosten" tone="violet"/><Metric icon={<TrendingUpIcon/>} label="Realisierter Gewinn" value={money(totalProfit)} detail="Nach erfassten Kosten" tone="green"/><Metric icon={<Truck size={19}/>} label="Gebühren & Versand" value={money(sold.reduce((s,p)=>s+p.fees+p.shipping,0))} detail="Erfasste Verkaufskosten" tone="amber"/></div>
              <section className="panel"><div className="panel-title-row"><div><h2>Verkaufshistorie</h2><p>Alle als verkauft markierten Produkte</p></div></div>{sold.length ? <ProductTable products={sold} onEdit={editProduct} onDelete={deleteProduct} onSell={setSelling} onReceipt={setReceiptProduct}/> : <EmptyState icon={<ShoppingBag size={22}/>} title="Noch keine Verkäufe" text="Ändere bei einem Produkt den Status auf „Verkauft“, um es hier zu sehen." action={<button className="button-secondary" onClick={() => setSection('Produkte')}>Zu den Produkten</button>}/>}</section>
            </>
          )}

          {section === 'Auswertungen' && <section className="panel coming-panel"><div className="coming-icon"><Sparkles size={23}/></div><h2>Auswertungen</h2><p>Hier bauen wir deine Monatsübersichten, Gewinnentwicklung und Plattformvergleiche auf.</p><span className="coming-tag">WIRD ALS NÄCHSTES ERWEITERT</span></section>}
          {section === 'Einstellungen' && <section className="panel settings-panel"><div className="panel-title-row"><div><h2>Lokaler Workspace</h2><p>Die App läuft ohne Konto, Anmeldung oder E-Mail-Versand.</p></div></div><div className="setting-row"><div><strong>Betriebsmodus</strong><span>Persönliche Nutzung auf diesem Gerät.</span></div><span className="setting-pill">Ohne Login</span></div><div className="setting-row"><div><strong>Erscheinungsbild</strong><span>Zwischen dem dunklen Neon-Look und dem hellen Design wechseln.</span></div><button className="setting-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={15}/> : <Moon size={15}/>} {theme === 'dark' ? 'Helles Design' : 'Dark Mode'}</button></div><div className="setting-row"><div><strong>Datenspeicherung</strong><span>Produkte werden nur in diesem Browser gespeichert. Es gibt keine Cloud-Synchronisierung.</span></div><span className="setting-pill">Lokal</span></div><div className="setting-row"><div><strong>Belege</strong><span>PDFs und Bilder werden im lokalen Browserspeicher dieses Geräts abgelegt.</span></div><span className="setting-pill">Auf diesem Gerät</span></div><div className="backup-section"><div className="backup-heading"><div><strong>Vollständiges PDF-Backup</strong><span>Sichere Produkte, Website-Einstellungen und sämtliche gespeicherten Originalbelege in einer einzigen PDF-Datei. Die Wiederherstellungsdaten sind in der PDF eingebettet.</span></div><HardDrive size={20}/></div><div className="backup-actions"><button className="button-primary" onClick={() => void createBackup()} disabled={backupBusy}><ArrowDownToLine size={15}/>{backupBusy ? 'PDF wird erstellt …' : 'PDF-Backup erstellen'}</button><button className="button-secondary" onClick={() => backupInput.current?.click()} disabled={backupBusy}><FileUp size={15}/> PDF / Backup importieren</button><input ref={backupInput} type="file" accept=".pdf,application/pdf,.zip,application/zip,.json,application/json,application/octet-stream" hidden onChange={e => void restoreBackup(e.target.files?.[0])}/></div>{pendingBackupFile && <div className="backup-actions"><button className="button-primary" onClick={() => void shareBackupFile()}><ArrowUpRight size={15}/> PDF in Dateien sichern / teilen</button><button className="button-secondary" onClick={downloadBackupFile}><ArrowDownToLine size={15}/> PDF herunterladen</button></div>}{backupMessage && <p className="backup-message" role="status">{backupMessage}</p>}<small>Auf dem iPhone im Teilen-Menü „In Dateien sichern“ wählen. Beim Wiederherstellen die unveränderte PDF auswählen. Ältere ZIP- und JSON-Backups bleiben ebenfalls importierbar.</small></div><div className="setting-row"><div><strong>Währung</strong><span>Wähle die Währung, in der Beträge angezeigt werden. Zahlenwerte werden dabei nicht umgerechnet.</span></div><select className="currency-select" value={currency} onChange={e => setCurrency(e.target.value)} aria-label="Anzeigewährung"><option value="EUR">Euro (€)</option><option value="USD">US-Dollar ($)</option><option value="GBP">Britisches Pfund (£)</option><option value="CHF">Schweizer Franken (CHF)</option></select></div><div className="setting-row"><div><strong>App-Version</strong><span>Reselling Manager – Invoice Studio</span></div><span className="setting-pill">0.3.0 Local</span></div></section>}
          <footer className="page-footer">Reselling Manager <span>·</span> Einfach den Überblick behalten.</footer>
        </div>
      </main>

      {showForm && <ProductModal product={editing} onClose={() => {setShowForm(false);setEditing(null)}} onSave={saveProduct}/>}
      {selling && <SaleModal product={selling} onClose={() => setSelling(null)} onSave={saveSale}/>}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)}/>}
      {receiptProduct && <ReceiptModal product={receiptProduct} onClose={() => setReceiptProduct(null)}/>}
    </div>
  )
}


function TrendingUpIcon() { return <ChartNoAxesCombined size={19}/> }

function Metric({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <div className="metric-card"><div className="metric-top"><span>{label}</span><div className={`metric-icon ${tone}`}>{icon}</div></div><strong className="metric-value">{value}</strong><span className="metric-detail">{detail}</span></div>
}

function EmptyState({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{text}</p>{action}</div>
}

function productGroupKey(product: Product): string {
  const normalize = (value: string) => value.trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' ')
  return normalize(product.name) + '|' + normalize(product.category)
}

function ProductTable({ products, onEdit, onDelete, onSell, onReceipt }: { products: Product[]; onEdit: (p: Product) => void; onDelete: (id: string) => void; onSell: (p: Product) => void; onReceipt: (p: Product) => void }) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const groups = new Map<string, Product[]>()
  for (const product of products) {
    const key = productGroupKey(product)
    const existing = groups.get(key) || []
    existing.push(product)
    groups.set(key, existing)
  }

  function renderUnitRow(product: Product, key: string, label?: string) {
    return <tr key={product.id} data-group-key={key} className={label ? 'product-unit-row' : undefined}>
      <td><div className={label ? 'product-name product-unit-name' : 'product-name'}>
        <div className="product-thumb">{product.imageUrl ? <img src={product.imageUrl} alt={product.name}/> : <Tag size={16}/>}</div>
        <div><strong>{product.name}</strong><span>{label ? label + ' · ' + (product.category || 'Ohne Kategorie') : (product.category || 'Ohne Kategorie')}</span>
          {product.receiptPath && <button className="receipt-inline" onClick={() => onReceipt(product)} title="Originalbeleg öffnen"><FileText size={12}/> Beleg öffnen</button>}
        </div>
      </div></td>
      <td>1</td>
      <td>{product.platform || '–'}</td>
      <td>{money(product.purchasePrice)}</td>
      <td>{product.status === 'Verkauft' ? money(product.salePrice) : '–'}</td>
      <td className={product.status === 'Verkauft' ? (profit(product) >= 0 ? 'positive' : 'negative') : 'table-muted'}>{product.status === 'Verkauft' ? money(profit(product)) : '–'}</td>
      <td><span className={product.status === 'Verkauft' ? 'status-badge sold' : 'status-badge stock'}>{product.status}</span></td>
      <td><div className="row-actions">
        <button className="sale-action" aria-label={product.status === 'Verkauft' ? 'Verkauf bearbeiten' : 'Verkauf eintragen'} title={product.status === 'Verkauft' ? 'Verkauf bearbeiten' : 'Verkauf eintragen'} onClick={() => onSell(product)}><DollarSign size={14}/><span>{product.status === 'Verkauft' ? 'Anpassen' : 'Verkauf'}</span></button>
        <button aria-label="Bearbeiten" title="Exemplar bearbeiten" onClick={() => onEdit(product)}><Pencil size={15}/></button>
        <button aria-label="Löschen" title="Exemplar löschen" onClick={() => onDelete(product.id)}><Trash2 size={15}/></button>
      </div></td>
    </tr>
  }

  return <div className="table-scroll"><table className="product-table"><thead><tr><th>PRODUKT</th><th>EXEMPLARE</th><th>PLATTFORM</th><th>EINKAUF GESAMT</th><th>VERKAUF</th><th>GEWINN</th><th>STATUS</th><th/></tr></thead><tbody>
    {[...groups.entries()].map(([key, items]) => {
      if (items.length === 1) return renderUnitRow(items[0], key)
      const first = items[0]
      const expanded = Boolean(expandedGroups[key])
      const inStock = items.filter(item => item.status === 'Auf Lager')
      const soldItems = items.filter(item => item.status === 'Verkauft')
      const purchaseTotal = items.reduce((sum, item) => sum + item.purchasePrice, 0)
      const saleTotal = soldItems.reduce((sum, item) => sum + item.salePrice, 0)
      const profitTotal = soldItems.reduce((sum, item) => sum + profit(item), 0)
      const platforms = [...new Set(items.map(item => item.platform).filter(Boolean))]
      const statusLabel = inStock.length && soldItems.length
        ? inStock.length + ' auf Lager · ' + soldItems.length + ' verkauft'
        : inStock.length ? 'Auf Lager' : 'Verkauft'
      const statusClass = inStock.length && soldItems.length ? 'mixed' : inStock.length ? 'stock' : 'sold'
      return <Fragment key={key}>
        <tr className="product-group-row">
          <td><div className="product-name">
            <button className="group-expand" aria-label={expanded ? 'Exemplare zuklappen' : 'Exemplare ausklappen'} aria-expanded={expanded} onClick={() => setExpandedGroups(current => ({ ...current, [key]: !current[key] }))}><ChevronDown size={15}/></button>
            <div className="product-thumb">{first.imageUrl ? <img src={first.imageUrl} alt={first.name}/> : <Tag size={16}/>}</div>
            <div><strong>{first.name}</strong><span>{first.category || 'Ohne Kategorie'} · {items.length} einzelne Exemplare</span>
              {first.receiptPath && <button className="receipt-inline" onClick={() => onReceipt(first)} title="Originalbeleg öffnen"><FileText size={12}/> Beleg öffnen</button>}
            </div>
          </div></td>
          <td><strong>{items.length}</strong></td>
          <td>{platforms.length > 1 ? 'Mehrere' : platforms[0] || '–'}</td>
          <td><strong>{money(purchaseTotal)}</strong><small className="group-average-price">Ø {money(purchaseTotal / items.length)} / Stück</small></td>
          <td>{saleTotal ? money(saleTotal) : '–'}</td>
          <td className={profitTotal >= 0 ? (soldItems.length ? 'positive' : 'table-muted') : 'negative'}>{soldItems.length ? money(profitTotal) : '–'}</td>
          <td><span className={'status-badge ' + statusClass}>{statusLabel}</span></td>
          <td><button className="group-count-button" onClick={() => setExpandedGroups(current => ({ ...current, [key]: !current[key] }))}>{expanded ? 'Zuklappen' : 'Details'} <ChevronDown size={13}/></button></td>
        </tr>
        {expanded && items.map((item, index) => renderUnitRow(item, key, 'Exemplar ' + (index + 1)))}
      </Fragment>
    })}
  </tbody></table></div>
}


function ReceiptModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let activeUrl = ''
    readLocalReceipt(product.receiptPath).then(blob => {
      if (!blob) { setError('Der lokal gespeicherte Beleg wurde nicht gefunden.'); return }
      activeUrl = URL.createObjectURL(blob)
      setUrl(activeUrl)
    }).catch(() => setError('Der Beleg konnte nicht geöffnet werden.'))
    return () => { if (activeUrl) URL.revokeObjectURL(activeUrl) }
  }, [product.receiptPath])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="modal-card receipt-modal"><div className="modal-header"><div><span className="overline">ORIGINALBELEG</span><h2>{product.name}</h2><p>Der Beleg wird direkt aus dem lokalen Gerätespeicher geladen.</p></div><button className="modal-close" onClick={onClose}><X size={19}/></button></div>{error ? <p className="receipt-error">{error}</p> : url ? <iframe className="receipt-frame" src={url} title={'Beleg für ' + product.name}/> : <div className="receipt-loading"><LoaderCircle className="spin" size={20}/> Beleg wird geöffnet …</div>}<div className="modal-actions"><button className="button-ghost" onClick={onClose}>Schließen</button>{url && <a className="button-primary receipt-download" href={url} target="_blank" rel="noreferrer">In neuem Tab öffnen <ExternalLink size={14}/></a>}</div></section></div>
}


function SaleModal({ product, onClose, onSave }: {
  product: Product
  onClose: () => void
  onSave: (values: { salePrice: number; shipping: number; fees: number; saleDate: string }) => void
}) {
  const [salePrice, setSalePrice] = useState(product.salePrice > 0 ? String(product.salePrice) : '')
  const [shipping, setShipping] = useState(String(product.shipping || 0))
  const [fees, setFees] = useState(String(product.fees || 0))
  const [saleDate, setSaleDate] = useState(product.saleDate || new Date().toISOString().slice(0, 10))
  const [error, setError] = useState('')
  const estimated = Number(salePrice || 0) - product.purchasePrice - Number(shipping || 0) - Number(fees || 0)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (salePrice.trim() === '' || !Number.isFinite(Number(salePrice)) || Number(salePrice) <= 0) {
      setError('Bitte gib einen gültigen Verkaufspreis ein.')
      return
    }
    onSave({ salePrice: Number(salePrice), shipping: Number(shipping || 0), fees: Number(fees || 0), saleDate })
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><form className="modal-card sale-modal" onSubmit={submit}>
    <div className="modal-header"><div><span className="overline">INVENTAR · VERKAUF</span><h2>{product.status === 'Verkauft' ? 'Verkauf bearbeiten' : 'Produkt verkaufen'}</h2><p>{product.name}</p></div><button type="button" className="modal-close" onClick={onClose}><X size={19}/></button></div>
    <div className="form-grid sale-form-grid">
      <div className="sale-product-summary full"><span>Einkaufspreis</span><strong>{money(product.purchasePrice)}</strong></div>
      <label className="field full"><span>Verkaufspreis gesamt (€) *</span><input autoFocus required type="number" min="0.01" step="0.01" value={salePrice} onChange={event => setSalePrice(event.target.value)} placeholder="z. B. 149,99"/></label>
      <label className="field"><span>Versandkosten (€)</span><input type="number" min="0" step="0.01" value={shipping} onChange={event => setShipping(event.target.value)}/></label>
      <label className="field"><span>Plattformgebühren (€)</span><input type="number" min="0" step="0.01" value={fees} onChange={event => setFees(event.target.value)}/></label>
      <label className="field full"><span>Verkaufsdatum</span><input type="date" value={saleDate} onChange={event => setSaleDate(event.target.value)}/></label>
      <div className="profit-preview full"><div><span>Voraussichtlicher Gewinn</span><small>Verkaufspreis − Einkaufspreis − Versand − Gebühren</small></div><strong className={estimated >= 0 ? 'positive' : 'negative'}>{money(estimated)}</strong></div>
      {error && <p className="inline-error full">{error}</p>}
    </div>
    <div className="modal-actions"><button type="button" className="button-ghost" onClick={onClose}>Abbrechen</button><button type="submit" className="button-primary">Verkauf speichern</button></div>
  </form></div>
}

function ProductModal({ product, onClose, onSave }: {
  product: Product | null
  onClose: () => void
  onSave: (products: Product[], invoiceFile?: File | null) => Promise<boolean>
}) {
  const [name, setName] = useState(product?.name || '')
  const [category, setCategory] = useState(product?.category || '')
  const [platform, setPlatform] = useState(product?.platform || '')
  const [purchasePrice, setPurchasePrice] = useState(product?.purchasePrice.toString() || '')
  const [purchaseDate, setPurchaseDate] = useState(product?.purchaseDate || new Date().toISOString().slice(0,10))
  const [quantity, setQuantity] = useState(String(product?.quantity || 1))
  const [imageUrl, setImageUrl] = useState(product?.imageUrl || '')
  const [imageAttribution, setImageAttribution] = useState(product?.imageAttribution || '')
  const [imageLicense, setImageLicense] = useState(product?.imageLicense || '')
  const [receiptPath, setReceiptPath] = useState(product?.receiptPath || '')
  const [receiptUrl, setReceiptUrl] = useState('')
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [invoiceLines, setInvoiceLines] = useState<InvoiceDraftLine[]>([])
  const [showForm, setShowForm] = useState(Boolean(product))
  const [scanBusy, setScanBusy] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)
  const [scanStage, setScanStage] = useState('')
  const [scanError, setScanError] = useState('')
  const [ocrText, setOcrText] = useState('')
  const [imageResults, setImageResults] = useState<ProductImageResult[]>([])
  const [imageBusy, setImageBusy] = useState(false)
  const [imageOptionsVisible, setImageOptionsVisible] = useState(false)
  const [imageError, setImageError] = useState('')
  const [saving, setSaving] = useState(false)
  const cameraInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const selectedLines = invoiceLines.filter(line => line.selected)
  const selectedLineTotal = selectedLines.reduce((sum, line) => sum + Number(line.amount || 0), 0)
  const selectedLineQuantity = selectedLines.reduce((sum, line) => sum + Math.max(1, Number(line.quantity || 1)), 0)

  useEffect(() => {
    let objectUrl = ''
    if (!receiptPath) { setReceiptUrl(''); return }
    readLocalReceipt(receiptPath).then(file => {
      if (!file) return
      objectUrl = URL.createObjectURL(file)
      setReceiptUrl(objectUrl)
    }).catch(() => setReceiptUrl(''))
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [receiptPath])

  async function loadImages(query: string, keepCurrent = false) {
    if (!query.trim()) return
    setImageBusy(true)
    setImageError('')
    try {
      const results = await searchProductImages(query)
      setImageResults(results)
      if (!keepCurrent && results.length > 0) {
        setImageUrl(results[0].url)
        setImageAttribution(results[0].creator)
        setImageLicense(results[0].license)
      }
      if (!results.length) setImageError('Kein passendes frei kommerziell nutzbares Bild gefunden. Du kannst Google Bilder öffnen oder später ein eigenes Bild hochladen.')
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Bildsuche fehlgeschlagen.')
    } finally {
      setImageBusy(false)
    }
  }

  function updateInvoiceLine(id: string, patch: Partial<InvoiceDraftLine>) {
    setInvoiceLines(current => current.map(line => line.id === id ? { ...line, ...patch } : line))
  }

  async function toggleLineImageOptions(line: InvoiceDraftLine) {
    if (line.showImageOptions) {
      updateInvoiceLine(line.id, { showImageOptions: false })
      return
    }
    updateInvoiceLine(line.id, { showImageOptions: true })
    if (!line.imageOptions.length && !line.imageLoading) {
      updateInvoiceLine(line.id, { imageLoading: true })
      try {
        const results = await searchProductImages(line.description)
        setInvoiceLines(current => current.map(item => item.id === line.id ? {
          ...item,
          imageOptions: results,
          imageLoading: false,
          imageUrl: item.imageUrl || results[0]?.url || '',
          imageAttribution: item.imageAttribution || results[0]?.creator || '',
          imageLicense: item.imageLicense || results[0]?.license || '',
        } : item))
      } catch {
        updateInvoiceLine(line.id, { imageLoading: false })
      }
    }
  }

  async function handleInvoiceFile(file?: File) {
    if (!file) return
    setInvoiceFile(file)
    setShowForm(true)
    setScanBusy(true)
    setScanError('')
    setScanProgress(0)
    setScanStage('Beleg wird vorbereitet')
    setInvoiceLines([])
    try {
      const extracted = await readInvoiceFile(file, (progress, stage) => {
        setScanProgress(Math.round(progress * 100))
        setScanStage(stage)
      })
      setOcrText(extracted.text)
      if (extracted.date) setPurchaseDate(extracted.date)
      if (extracted.lineItems.length > 1 || extracted.lineItems.some(line => line.confidence < 0.72)) {
        const initialLines: InvoiceDraftLine[] = extracted.lineItems.map(line => ({
          ...line,
          selected: line.confidence >= 0.72,
          imageUrl: '',
          imageAttribution: '',
          imageLicense: '',
          imageOptions: [],
          imageLoading: true,
          showImageOptions: false,
        }))
        setInvoiceLines(initialLines)
        setName(extracted.name || initialLines[0].description)
        setQuantity(String(extracted.quantity || 1))
        setPurchasePrice(String(extracted.amount ?? initialLines.reduce((sum, line) => sum + line.amount, 0)))
        const withImages = await Promise.all(initialLines.map(async line => {
          try {
            const results = await searchProductImages(line.description)
            return {
              ...line,
              imageOptions: results,
              imageUrl: results[0]?.url || '',
              imageAttribution: results[0]?.creator || '',
              imageLicense: results[0]?.license || '',
              imageLoading: false,
            }
          } catch {
            return { ...line, imageLoading: false }
          }
        }))
        setInvoiceLines(withImages)
      } else {
        const firstLine = extracted.lineItems[0]
        const productName = firstLine?.description || extracted.name
        setInvoiceLines([])
        if (productName) setName(productName)
        if (firstLine) {
          setPurchasePrice(firstLine.amount.toFixed(2))
          setQuantity(String(firstLine.quantity || 1))
        } else if (extracted.amount !== null) {
          setPurchasePrice(extracted.amount.toFixed(2))
          setQuantity(String(extracted.quantity || 1))
        }
        if (productName) await loadImages(productName)
        else setImageError('Der Produktname war auf dem Beleg nicht eindeutig. Bitte trage ihn selbst ein.')
      }
      setScanStage('Automatische Auswertung abgeschlossen')
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Der Beleg konnte nicht gelesen werden.')
    } finally {
      setScanBusy(false)
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (invoiceLines.length > 0) {
      if (!selectedLines.length || selectedLines.some(line => !line.description.trim() || Number(line.quantity) < 1 || Number(line.amount) <= 0)) return
    } else if (!name.trim() || purchasePrice === '' || !Number.isFinite(Number(purchasePrice)) || Number(quantity) < 1) {
      return
    }

    setSaving(true)
    const common = {
      category,
      platform,
      salePrice: product?.salePrice || 0,
      shipping: product?.shipping || 0,
      fees: product?.fees || 0,
      purchaseDate,
      saleDate: product?.saleDate || '',
      status: product?.status || 'Auf Lager' as Status,
      receiptPath,
    }

    let products: Product[]
    if (invoiceLines.length > 0) {
      products = selectedLines.flatMap(line => {
        const count = Math.max(1, Math.floor(Number(line.quantity) || 1))
        const groupId = crypto.randomUUID()
        const unitPrices = splitMoneyAmount(Number(line.amount || 0), count)
        return Array.from({ length: count }, (_, index) => ({
          id: crypto.randomUUID(),
          groupId,
          name: line.description.trim(),
          ...common,
          salePrice: 0,
          shipping: 0,
          fees: 0,
          status: 'Auf Lager' as Status,
          purchasePrice: unitPrices[index],
          quantity: 1,
          imageUrl: line.imageUrl,
          imageAttribution: line.imageAttribution,
          imageLicense: line.imageLicense,
        }))
      })
    } else if (product) {
      products = [{
        id: product.id,
        groupId: product.groupId || product.id,
        name: name.trim(),
        ...common,
        purchasePrice: Number(purchasePrice),
        quantity: 1,
        imageUrl,
        imageAttribution,
        imageLicense,
      }]
    } else {
      const count = Math.max(1, Math.floor(Number(quantity) || 1))
      const groupId = crypto.randomUUID()
      const unitPrices = splitMoneyAmount(Number(purchasePrice), count)
      products = Array.from({ length: count }, (_, index) => ({
        id: crypto.randomUUID(),
        groupId,
        name: name.trim(),
        ...common,
        salePrice: 0,
        shipping: 0,
        fees: 0,
        status: 'Auf Lager' as Status,
        purchasePrice: unitPrices[index],
        quantity: 1,
        imageUrl,
        imageAttribution,
        imageLicense,
      }))
    }

    void onSave(products, invoiceFile).then(saved => {
      if (saved) onClose()
    }).finally(() => setSaving(false))
  }

  const selection = !showForm && !product

  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose() }}><div className="modal-card product-modal-card">
    <div className="modal-header"><div><span className="overline">{product ? 'INVENTAR' : 'NEUES INVENTAR'}</span><h2>{product ? 'Produkt bearbeiten' : 'Produkt hinzufügen'}</h2><p>{product ? 'Passe Produktdaten, Stückzahl und Beleg an.' : 'Starte mit einem Kassenbon, einer Rechnung oder der manuellen Erfassung.'}</p></div><button className="modal-close" onClick={onClose} disabled={saving}><X size={19}/></button></div>
    <div className="invoice-entry">
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={e => { void handleInvoiceFile(e.target.files?.[0]); e.currentTarget.value = '' }}/>
      <input ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden onChange={e => { void handleInvoiceFile(e.target.files?.[0]); e.currentTarget.value = '' }}/>
      {selection && <div className="invoice-choice-grid">
        <button type="button" className="invoice-choice featured" onClick={() => cameraInput.current?.click()}><span className="invoice-choice-icon"><Camera size={22}/></span><strong>Rechnung scannen</strong><small>Kamera öffnen und Beleg fotografieren</small><span className="choice-cta">Kamera starten <ExternalLink size={13}/></span></button>
        <button type="button" className="invoice-choice" onClick={() => fileInput.current?.click()}><span className="invoice-choice-icon"><FileUp size={22}/></span><strong>Datei hochladen</strong><small>PDF, JPG, PNG oder WebP auswählen</small><span className="choice-cta">Datei wählen <ExternalLink size={13}/></span></button>
        <button type="button" className="invoice-manual" onClick={() => setShowForm(true)}>Ohne Beleg manuell starten</button>
      </div>}
      {!selection && <div className="invoice-toolbar"><div className="invoice-file-status">{invoiceFile ? <><FileText size={16}/><span>{invoiceFile.name}</span></> : receiptPath ? <><FileText size={16}/><span>Beleg bereits gespeichert</span>{receiptUrl && <a href={receiptUrl} target="_blank" rel="noreferrer">Ansehen</a>}</> : <><FileText size={16}/><span>Kein Beleg angehängt</span></>}</div><div className="invoice-toolbar-actions"><button type="button" onClick={() => cameraInput.current?.click()}><Camera size={14}/> Scannen</button><button type="button" onClick={() => fileInput.current?.click()}><FileUp size={14}/> Datei</button></div></div>}
      {scanBusy && <div className="scan-progress"><div className="scan-progress-top"><span><RefreshCw size={14} className="spin"/> {scanStage}</span><strong>{scanProgress}%</strong></div><div className="progress-track"><i style={{width: scanProgress + '%'}}/></div><small>Die lokale KI analysiert Belegtext und Tabellenpositionen. Das Modell wird einmalig geladen (mehrere hundert MB) und danach im Browser zwischengespeichert. Deine Rechnung wird nicht an einen KI-Dienst hochgeladen.</small></div>}
      {scanError && <div className="inline-error">{scanError}</div>}
    </div>
    {showForm && <form onSubmit={submit}><div className="form-grid">
      {invoiceLines.length > 0 ? <div className="invoice-lines-panel full">
        <div className="invoice-lines-heading"><div><strong>{invoiceLines.length} erkannte Positionen</strong><small>Sichere Positionen sind vorausgewählt. Unsichere Erkennungen musst du aktiv auswählen. Prüfe Namen, Stückzahl und Gesamtpreis je Position.</small></div><span>{selectedLines.length} ausgewählt</span></div>
        {invoiceLines.map(line => <div className="invoice-line-card" key={line.id}>
          <div className="invoice-line-top"><input type="checkbox" checked={line.selected} onChange={e => updateInvoiceLine(line.id,{selected:e.target.checked})}/><input className="invoice-line-name" value={line.description} onChange={e => updateInvoiceLine(line.id,{description:e.target.value})} aria-label="Artikelname"/><span className={line.confidence >= 0.72 ? 'invoice-confidence good' : 'invoice-confidence review'}>{line.confidence >= 0.72 ? 'Sicher' : 'Bitte prüfen'} · {Math.round(line.confidence * 100)}%</span></div>
          <div className="invoice-line-bottom">
            <label><span>Stück</span><input type="number" min="1" step="1" value={line.quantity} onChange={e => updateInvoiceLine(line.id,{quantity:Number(e.target.value)})}/></label>
            <label><span>Gesamtpreis (€)</span><input type="number" min="0" step="0.01" value={line.amount} onChange={e => updateInvoiceLine(line.id,{amount:Number(e.target.value)})}/></label>
            <div className="invoice-line-image">
              {line.imageUrl ? <img src={line.imageUrl} alt={line.description}/> : <span className="invoice-line-no-image"><ImagePlus size={16}/></span>}
              <div><small>{line.imageAttribution ? 'Bild: ' + line.imageAttribution : line.imageLoading ? 'Bild wird gesucht …' : 'Kein Bild gefunden'}</small><button type="button" onClick={() => void toggleLineImageOptions(line)}>{line.showImageOptions ? 'Auswahl schließen' : 'Bild ändern'}</button></div>
            </div>
          </div>
          {line.showImageOptions && <div className="invoice-line-options">
            {line.imageLoading ? <small>Bildsuche läuft …</small> : line.imageOptions.map(option => <button type="button" key={option.id} className={line.imageUrl === option.url ? 'image-choice-thumb chosen' : 'image-choice-thumb'} onClick={() => updateInvoiceLine(line.id,{imageUrl:option.url,imageAttribution:option.creator,imageLicense:option.license,showImageOptions:false})}><img src={option.thumbnail} alt={option.title}/></button>)}
            <a href={googleImagesUrl(line.description)} target="_blank" rel="noreferrer">Google Bilder öffnen <ExternalLink size={12}/></a>
          </div>}
        </div>)}
        <div className="invoice-lines-total"><span>Ausgewählte Artikel · {selectedLineQuantity} Stück</span><strong>{money(selectedLineTotal)}</strong></div>
      </div> : <>
        <label className="field full"><span>Produktname *</span><input autoFocus required value={name} onChange={e=>setName(e.target.value)} onBlur={() => { if (name.trim() && !imageUrl && !imageBusy) void loadImages(name) }} placeholder="z. B. Pokémon ETB – Hidden Fates"/></label>
        <label className="field"><span>{product ? 'Einzelstück' : 'Stückzahl *'}</span><input required type="number" min="1" step="1" disabled={Boolean(product)} value={product ? '1' : quantity} onChange={e=>setQuantity(e.target.value)}/></label>
        <label className="field"><span>{product ? 'Einkaufspreis dieses Exemplars (€) *' : 'Einkaufspreis gesamt (€) *'}</span><input required type="number" min="0" step="0.01" value={purchasePrice} onChange={e=>setPurchasePrice(e.target.value)} placeholder="0,00"/></label>
        <div className="form-section full"><span>PRODUKTBILD</span></div>
        <div className="image-picker full">
          {imageUrl ? <div className="selected-image"><img src={imageUrl} alt="Automatisch gewähltes Produktbild"/><div><strong>Automatisches Produktbild</strong><small>{imageAttribution ? 'Bildnachweis: ' + imageAttribution : 'Bild automatisch gewählt'}{imageLicense ? ' · ' + imageLicense : ''}</small><button type="button" onClick={() => {setImageUrl('');setImageAttribution('');setImageLicense('')}}>Entfernen</button></div></div> : <div className="image-empty"><ImagePlus size={18}/><span>{imageError || 'Das Produktbild wird automatisch gesucht.'}</span></div>}
          <div className="image-search-row">
            <button type="button" className="button-secondary" disabled={!name.trim() || imageBusy} onClick={() => {setImageOptionsVisible(v => !v); if (!imageResults.length) void loadImages(name,true)}}>{imageBusy ? <RefreshCw size={14} className="spin"/> : <Search size={14}/>} {imageOptionsVisible ? 'Auswahl schließen' : 'Bild ändern'}</button>
            {name.trim() && <a href={googleImagesUrl(name)} target="_blank" rel="noreferrer">Google Bilder öffnen <ExternalLink size={12}/></a>}
          </div>
          {imageOptionsVisible && <div className="image-suggestions">{imageResults.map(item => <button type="button" key={item.id} className={imageUrl === item.url ? 'image-choice-thumb chosen' : 'image-choice-thumb'} onClick={() => {setImageUrl(item.url);setImageAttribution(item.creator);setImageLicense(item.license);setImageOptionsVisible(false)}}><img src={item.thumbnail} alt={item.title}/><span>{item.creator || item.title}</span></button>)}</div>}
        </div>
      </>}
      <label className="field"><span>Kategorie</span><input value={category} onChange={e=>setCategory(e.target.value)} placeholder="z. B. Trading Cards"/></label>
      <label className="field"><span>Einkaufsdatum</span><input type="date" value={purchaseDate} onChange={e=>setPurchaseDate(e.target.value)}/></label>
      <label className="field"><span>Plattform</span><select value={platform} onChange={e=>setPlatform(e.target.value)}><option value="">Bitte wählen</option><option>eBay</option><option>Kleinanzeigen</option><option>Vinted</option><option>Cardmarket</option><option>Facebook Marketplace</option><option>Sonstige</option></select></label>
      <div className="form-note full"><Package size={15}/> Das Produkt wird zunächst als Bestand gespeichert. Den Verkauf kannst du später direkt im Inventar eintragen.</div>
      {ocrText && <details className="ocr-details full"><summary>Erkannten Rechnungstext anzeigen</summary><pre>{ocrText.slice(0, 8000)}</pre></details>}
    </div><div className="modal-actions"><button type="button" className="button-ghost" onClick={onClose} disabled={saving}>Abbrechen</button><button type="submit" className="button-primary" disabled={saving || scanBusy || (invoiceLines.length > 0 && selectedLines.length === 0)}>{saving ? <LoaderCircle size={15} className="spin"/> : null}{saving ? 'Speichert …' : product ? 'Änderungen speichern' : invoiceLines.length > 0 ? selectedLines.length + ' Positionen hinzufügen' : 'Produkt speichern'}</button></div></form>}
  </div></div>
}



function HelpModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop help-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="modal-card help-card">
    <div className="modal-header"><div><span className="overline">RESSELLMANAGER GUIDE</span><h2>Wie können wir helfen?</h2><p>Die wichtigsten Funktionen auf einen Blick.</p></div><button className="modal-close" onClick={onClose}><X size={19}/></button></div>
    <div className="help-content">
      <div className="help-item"><span><FileUp size={18}/></span><div><strong>Rechnung intelligent erfassen</strong><p>Die lokale Florence-2-KI liest Text und Tabellenpositionen im Browser aus. Positionen werden anhand von Tabellenstruktur und Summen geprüft. Unsichere Treffer musst du vor dem Speichern auswählen. Falls die KI auf dem Gerät nicht läuft, springt die normale Browser-Texterkennung ein. Beim ersten Einsatz wird das KI-Modell einmalig aus dem Internet geladen (mehrere hundert MB).</p></div></div>
      <div className="help-item"><span><ImagePlus size={18}/></span><div><strong>Produktbilder</strong><p>Nach der Rechnungserkennung wird automatisch das bestplatzierte kommerziell nutzbare Bild von Openverse ausgewählt. Über „Bild ändern“ kannst du andere Bilder ansehen. Google Bilder öffnet eine separate Suche; deren erstes Ergebnis kann die App nicht automatisch auslesen.</p></div></div>
      <div className="help-item"><span><Moon size={18}/></span><div><strong>Dark Mode</strong><p>Über das Mond-/Sonnensymbol oben kannst du jederzeit zwischen dunklem und hellem Erscheinungsbild wechseln.</p></div></div>
      <div className="help-item"><span><HardDrive size={18}/></span><div><strong>Lokale Daten</strong><p>Produkte und Originalbelege bleiben im Speicher dieses Browsers auf diesem Gerät. Es gibt keine Anmeldung, keine Cloud-Synchronisierung und keine automatische Sicherung. Für die Bildsuche wird nur der erkannte Produktname an Openverse übermittelt.</p></div></div>
    </div>
    <div className="modal-actions"><button className="button-primary" onClick={onClose}>Alles klar</button></div>
  </section></div>
}

export default App