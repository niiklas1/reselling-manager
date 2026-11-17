import { useEffect, useMemo, useRef, useState } from 'react'
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


type Currency = 'EUR' | 'USD' | 'GBP' | 'CHF'
const CURRENCY_STORAGE_KEY = 'reselling-currency'
const SUPPORTED_CURRENCIES: Currency[] = ['EUR', 'USD', 'GBP', 'CHF']
function getCurrency(): Currency {
  const saved = localStorage.getItem(CURRENCY_STORAGE_KEY)
  return SUPPORTED_CURRENCIES.includes(saved as Currency) ? saved as Currency : 'EUR'
}
const currencySymbol = () => new Intl.NumberFormat('de-DE', { style: 'currency', currency: getCurrency() }).formatToParts(0).find(part => part.type === 'currency')?.value || getCurrency()
const money = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: getCurrency() }).format(value)

const profit = (p: Product) => p.salePrice - p.purchasePrice - p.shipping - p.fees

function readStoredProducts(): Product[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PRODUCTS_STORAGE_KEY) || '[]')
    if (!Array.isArray(stored)) return []
    return stored.map((item: Partial<Product>) => ({
      id: item.id || crypto.randomUUID(),
      name: item.name || '',
      category: item.category || '',
      platform: item.platform || '',
      purchasePrice: Number(item.purchasePrice || 0),
      salePrice: Number(item.salePrice || 0),
      shipping: Number(item.shipping || 0),
      fees: Number(item.fees || 0),
      purchaseDate: item.purchaseDate || '',
      saleDate: item.saleDate || '',
      status: item.status === 'Verkauft' ? 'Verkauft' : 'Auf Lager',
      quantity: Math.max(1, Number(item.quantity || 1)),
      imageUrl: item.imageUrl || '',
      imageAttribution: item.imageAttribution || '',
      imageLicense: item.imageLicense || '',
      receiptPath: item.receiptPath?.startsWith('local:') ? item.receiptPath : '',
    }))
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



type BackupV1Receipt = { name: string; type: string; data: string }
type BackupV1 = { format: 'reselling-manager-backup'; version: 1; createdAt: string; products: Product[]; receipts: Record<string, BackupV1Receipt> }
type BackupV2Receipt = { name: string; type: string; archivePath: string }
type BackupV2 = { format: 'reselling-manager-backup'; version: 2; createdAt: string; currency: Currency; products: Product[]; receipts: Record<string, BackupV2Receipt> }
type StoredZipEntry = { name: string; data: Uint8Array }

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()
let crcTable: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let value = n
      for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      crcTable[n] = value >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

// Creates a standards-compliant ZIP using the "store" method. Receipt files are
// kept as their original binary data instead of being expanded into base64 text.
function createStoredZip(entries: StoredZipEntry[]): Blob {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = utf8Encoder.encode(entry.name)
    const data = entry.data
    if (name.length > 65535 || data.length > 0xffffffff) throw new Error('Eine Backup-Datei ist zu groß.')
    const crc = crc32(data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, 0, true)
    lv.setUint16(10, 0, true)
    lv.setUint16(12, 0x21, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)
    localParts.push(local, data)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, localOffset, true)
    central.set(name, 46)
    centralParts.push(central)
    localOffset += local.length + data.length
  }

  const centralDirectory = joinBytes(centralParts)
  if (entries.length > 65535 || centralDirectory.length > 0xffffffff || localOffset > 0xffffffff) {
    throw new Error('Das Backup enthält zu viele oder zu große Dateien.')
  }
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralDirectory.length, true)
  ev.setUint32(16, localOffset, true)
  ev.setUint16(20, 0, true)
  return new Blob([...localParts, centralDirectory, end], { type: 'application/zip' })
}

function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true)
    const method = view.getUint16(offset + 8, true)
    const expectedCrc = view.getUint32(offset + 14, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const uncompressedSize = view.getUint32(offset + 22, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    if ((flags & 0x0008) !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error('Dieses ZIP-Backup verwendet ein nicht unterstütztes Kompressionsformat. Bitte verwende die originale Backup-Datei der App.')
    }
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length || dataStart < nameStart) throw new Error('Die Backup-Datei ist unvollständig oder beschädigt.')
    const name = utf8Decoder.decode(bytes.slice(nameStart, nameStart + nameLength))
    const data = bytes.slice(dataStart, dataEnd)
    if (crc32(data) !== expectedCrc) throw new Error('Die Backup-Datei ist beschädigt (Prüfsumme stimmt nicht).')
    entries.set(name, data)
    offset = dataEnd
  }
  if (!entries.size) throw new Error('Keine gültigen Backup-Daten in der ZIP-Datei gefunden.')
  return entries
}

function safeArchiveName(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90)
  return cleaned || 'beleg'
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Ein Beleg im alten Backup hat ein ungültiges Format.')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: match[1] || 'application/octet-stream' })
}

async function saveBackupFile(file: File): Promise<void> {
  const shareNavigator = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
    share?: (data: ShareData) => Promise<void>
  }
  if (shareNavigator.share && shareNavigator.canShare?.({ files: [file] })) {
    await shareNavigator.share({ files: [file], title: 'Reselling Manager Backup' })
    return
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Safari/iOS may only start processing the download after the click handler returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 120000)
}

function App() {
  const [section, setSection] = useState<Section>('Übersicht')
  const [profileReturnSection, setProfileReturnSection] = useState<Section>('Übersicht')
  const [currency, setCurrency] = useState<Currency>(getCurrency)
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
  const [backupMessage, setBackupMessage] = useState('')
  const backupInput = useRef<HTMLInputElement>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('reselling-theme')
    return saved === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    localStorage.setItem(CURRENCY_STORAGE_KEY, currency)
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
      const archiveEntries: StoredZipEntry[] = []
      const receiptIndex: Record<string, BackupV2Receipt> = {}
      const receiptPaths = [...new Set(products.map(product => product.receiptPath).filter(path => path.startsWith('local:')))]
      for (let index = 0; index < receiptPaths.length; index++) {
        const path = receiptPaths[index]
        const blob = await readLocalReceipt(path)
        if (!blob) throw new Error('Ein gespeicherter Beleg fehlt. Das Backup wurde abgebrochen, damit die Sicherung vollständig bleibt.')
        const name = blob instanceof File ? blob.name : 'beleg'
        const type = blob.type || 'application/octet-stream'
        const archivePath = 'receipts/' + String(index + 1).padStart(4, '0') + '-' + safeArchiveName(name)
        archiveEntries.push({ name: archivePath, data: new Uint8Array(await blob.arrayBuffer()) })
        receiptIndex[path] = { name, type, archivePath }
      }
      const backup: BackupV2 = {
        format: 'reselling-manager-backup',
        version: 2,
        createdAt: new Date().toISOString(),
        currency,
        products,
        receipts: receiptIndex,
      }
      archiveEntries.unshift({ name: 'backup.json', data: utf8Encoder.encode(JSON.stringify(backup)) })
      const zipBlob = createStoredZip(archiveEntries)
      const backupFile = new File(
        [zipBlob],
        'reselling-manager-backup-' + new Date().toISOString().slice(0, 10) + '.zip',
        { type: 'application/zip' },
      )
      await saveBackupFile(backupFile)
      setBackupMessage('Backup-Datei bereit: ' + products.length + ' Produkte und ' + receiptPaths.length + ' Originalbelege. Auf iPhone/iPad im Teilen-Menü „In Dateien sichern“ wählen.')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setBackupMessage('Backup-Erstellung abgebrochen. Es wurden keine Daten verändert.')
      } else {
        setBackupMessage(error instanceof Error ? error.message : 'Backup konnte nicht erstellt werden.')
      }
    } finally {
      setBackupBusy(false)
    }
  }

  async function restoreBackup(file?: File) {
    if (!file) return
    setBackupBusy(true)
    setBackupMessage('')
    const createdReceiptPaths: string[] = []
    try {
      if (file.size > 512 * 1024 * 1024) throw new Error('Die Backup-Datei ist größer als 512 MB.')
      const bytes = new Uint8Array(await file.arrayBuffer())
      let productsToRestore: Product[]
      let receiptFiles: Array<{ oldPath: string; name: string; type: string; blob: Blob }> = []
      let restoredCurrency: Currency | null = null

      const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
      if (isZip) {
        const entries = readStoredZip(bytes)
        const manifestBytes = entries.get('backup.json')
        if (!manifestBytes) throw new Error('In der ZIP-Datei fehlt die Backup-Übersicht (backup.json).')
        const parsed = JSON.parse(utf8Decoder.decode(manifestBytes)) as Partial<BackupV2>
        if (parsed.format !== 'reselling-manager-backup' || parsed.version !== 2 || !Array.isArray(parsed.products) || !parsed.receipts || typeof parsed.receipts !== 'object') {
          throw new Error('Diese ZIP-Datei ist kein gültiges Reselling-Manager-Backup.')
        }
        if (parsed.currency && SUPPORTED_CURRENCIES.includes(parsed.currency)) restoredCurrency = parsed.currency
        receiptFiles = Object.entries(parsed.receipts).map(([oldPath, receipt]) => {
          if (!receipt || typeof receipt.name !== 'string' || typeof receipt.type !== 'string' || typeof receipt.archivePath !== 'string') {
            throw new Error('Die Backup-Übersicht enthält einen ungültigen Beleg-Eintrag.')
          }
          const data = entries.get(receipt.archivePath)
          if (!data) throw new Error('Ein Originalbeleg fehlt in der ZIP-Datei: ' + receipt.name)
          return { oldPath, name: receipt.name, type: receipt.type, blob: new Blob([data], { type: receipt.type }) }
        })
        productsToRestore = parsed.products
      } else {
        // Continue to accept the older JSON backup format for files created by version 1.
        let parsed: Partial<BackupV1>
        try {
          parsed = JSON.parse(utf8Decoder.decode(bytes)) as Partial<BackupV1>
        } catch {
          throw new Error('Datei nicht erkannt. Bitte wähle eine ZIP-Backup-Datei aus „Backup-Datei erstellen“ – keine PDF- oder Vorschau-Datei.')
        }
        if (parsed.format !== 'reselling-manager-backup' || parsed.version !== 1 || !Array.isArray(parsed.products) || !parsed.receipts || typeof parsed.receipts !== 'object') {
          throw new Error('Diese Datei ist kein gültiges Reselling-Manager-Backup.')
        }
        receiptFiles = Object.entries(parsed.receipts).map(([oldPath, receipt]) => {
          if (!receipt || typeof receipt.data !== 'string' || typeof receipt.name !== 'string' || typeof receipt.type !== 'string') {
            throw new Error('Ein Beleg im alten Backup ist beschädigt.')
          }
          return { oldPath, name: receipt.name, type: receipt.type, blob: dataUrlToBlob(receipt.data) }
        })
        productsToRestore = parsed.products
      }

      const normalizedProducts = productsToRestore.map(product => {
        if (!product || typeof product.id !== 'string' || typeof product.name !== 'string') {
          throw new Error('Das Backup enthält ungültige Produktdaten.')
        }
        return product
      })
      const receiptMap = new Map(receiptFiles.map(receipt => [receipt.oldPath, receipt]))
      for (const product of normalizedProducts) {
        if (typeof product.receiptPath === 'string' && product.receiptPath.startsWith('local:') && !receiptMap.has(product.receiptPath)) {
          throw new Error('Zu „' + product.name + '“ fehlt der Originalbeleg in der Backup-Datei.')
        }
      }

      if (!window.confirm('Das Backup ersetzt alle aktuell gespeicherten Produkte und Belege. Möchtest du fortfahren?')) return

      const newPaths: Record<string, string> = {}
      for (const receipt of receiptFiles) {
        const savedPath = await saveLocalReceipt(new File([receipt.blob], receipt.name, { type: receipt.type }))
        newPaths[receipt.oldPath] = savedPath
        createdReceiptPaths.push(savedPath)
      }
      const restored = normalizedProducts.map(product => ({
        ...product,
        receiptPath: typeof product.receiptPath === 'string' && product.receiptPath.startsWith('local:')
          ? (newPaths[product.receiptPath] || '')
          : '',
      }))
      // Commit the product list only after every receipt has been written successfully.
      localStorage.setItem(PRODUCTS_STORAGE_KEY, JSON.stringify(restored))
      setProducts(restored)
      if (restoredCurrency) {
        localStorage.setItem(CURRENCY_STORAGE_KEY, restoredCurrency)
        setCurrency(restoredCurrency)
      }
      const oldPaths = [...new Set(products.map(product => product.receiptPath).filter(path => path.startsWith('local:')))]
      for (const oldPath of oldPaths) {
        if (!restored.some(product => product.receiptPath === oldPath)) {
          try { await deleteLocalReceipt(oldPath) } catch { /* The restored products remain safe. */ }
        }
      }
      createdReceiptPaths.length = 0
      setBackupMessage('Wiederherstellung erfolgreich: ' + restored.length + ' Produkte und ' + receiptFiles.length + ' Originalbelege importiert.')
    } catch (error) {
      for (const path of createdReceiptPaths) {
        try { await deleteLocalReceipt(path) } catch { /* Leave a possible orphan rather than hide the original error. */ }
      }
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

  function toggleProfile() {
    if (section === 'Einstellungen') {
      setSection(profileReturnSection)
    } else {
      setProfileReturnSection(section)
      setSection('Einstellungen')
    }
    setMobileNav(false)
  }

  async function viewReceipt(path: string) {
    const preview = window.open('about:blank', '_blank')
    if (!preview) {
      setDataError('Der Beleg konnte nicht geöffnet werden. Bitte erlaube Pop-ups für diese Website.')
      return
    }
    preview.document.title = 'Beleg wird geöffnet'
    preview.document.body.textContent = 'Beleg wird geöffnet …'
    try {
      const blob = await readLocalReceipt(path)
      if (!blob) throw new Error('Der Originalbeleg wurde im lokalen Speicher nicht gefunden.')
      const url = URL.createObjectURL(blob)
      preview.location.href = url
      window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000)
    } catch (error) {
      preview.close()
      setDataError(error instanceof Error ? error.message : 'Beleg konnte nicht geöffnet werden.')
    }
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
        <button className="profile-card" onClick={toggleProfile} aria-expanded={section === 'Einstellungen'} title="Einstellungen öffnen oder schließen"><div className="profile-avatar">N</div><div className="profile-copy"><strong>Mein Workspace</strong><span>Lokales Gerät</span></div><ChevronDown size={15} className="profile-chevron"/></button>
        <div className="sidebar-foot">RESSELLMANAGER <span>·</span> V 0.1</div>
      </aside>

      {mobileNav && <button className="mobile-backdrop" aria-label="Menü schließen" onClick={() => setMobileNav(false)}/>}

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={20}/></button>
          <div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{section}</strong></div>
          <div className="topbar-right"><span className="local-status"><i/> Nur dieses Gerät</span><button className="top-icon" aria-label="Hilfe" title="Hilfe" onClick={() => setShowHelp(true)}><CircleHelp size={18}/></button><button className="theme-toggle" aria-label={theme === 'dark' ? 'Helles Design aktivieren' : 'Dark Mode aktivieren'} title={theme === 'dark' ? 'Helles Design' : 'Dark Mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}</button><button className="top-avatar top-avatar-button" onClick={toggleProfile} aria-expanded={section === 'Einstellungen'} title="Einstellungen öffnen oder schließen">N</button></div>
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
                  {sold.length === 0 ? <EmptyState icon={<ChartNoAxesCombined size={22}/>} title="Noch keine Verkaufsdaten" text="Sobald du ein Produkt als verkauft markierst, erscheinen hier deine Kennzahlen."/> : <div className="performance-numbers"><div><span>Umsatz</span><strong>{money(revenue)}</strong></div><div><span>Gewinn</span><strong className={totalProfit >= 0 ? 'positive' : 'negative'}>{money(totalProfit)}</strong></div><div><span>Ø Gewinn / Verkauf</span><strong>{money(totalProfit / sold.length)}</strong></div></div>}
                  <div className="panel-divider"/><div className="mini-legend"><span><i className="legend-blue"/> Umsatz</span><span><i className="legend-violet"/> Gewinn</span></div>
                </section>
                <section className="panel quick-panel"><div className="panel-title-row"><div><h2>Schnellübersicht</h2><p>Deine offenen Bestände</p></div><Box size={18} className="muted-icon"/></div><div className="quick-row"><span>Stück auf Lager</span><strong>{stockUnits}</strong></div><div className="quick-row"><span>Verkaufte Produkte</span><strong>{sold.length}</strong></div><div className="quick-row"><span>Investiertes Kapital</span><strong>{money(investment)}</strong></div><button className="subtle-button" onClick={() => setSection('Produkte')}>Bestand ansehen <ArrowUpRight size={15}/></button></section>
              </div>
              <section className="panel recent-panel"><div className="panel-title-row"><div><h2>Zuletzt hinzugefügt</h2><p>Deine neuesten Produkte</p></div><button className="text-action" onClick={() => setSection('Produkte')}>Alle Produkte ansehen <ArrowUpRight size={14}/></button></div>
                {products.length === 0 ? <EmptyState icon={<Package size={22}/>} title="Dein Reselling startet hier" text="Lege dein erstes Produkt an und behalte Einkauf, Verkauf und Gewinn im Blick." action={<button className="button-secondary" onClick={openNew}><Plus size={15}/> Erstes Produkt anlegen</button>}/> : <ProductTable products={products.slice(0, 5)} onEdit={editProduct} onDelete={deleteProduct} onSell={setSelling} onViewReceipt={viewReceipt}/>}
              </section>
            </>
          )}

          {section === 'Produkte' && (
            <>
              <div className="page-header"><div><div className="overline">INVENTAR VERWALTEN</div><h1>Produkte</h1><p>Verwalte deine Einkäufe, Bestände und Verkäufe.</p></div><button className="button-primary" onClick={openNew}><Plus size={17}/> Produkt hinzufügen</button></div>
              <div className="panel inventory-panel"><div className="inventory-toolbar"><div className="search-box"><Search size={17}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Produkte suchen..."/></div><div className="filter-control"><SlidersHorizontal size={16}/><select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option>Alle</option><option>Auf Lager</option><option>Verkauft</option></select></div></div>
                {visibleProducts.length ? <ProductTable products={visibleProducts} onEdit={editProduct} onDelete={deleteProduct} onSell={setSelling} onViewReceipt={viewReceipt}/> : <EmptyState icon={<Package size={22}/>} title={products.length ? 'Keine Produkte gefunden' : 'Noch keine Produkte vorhanden'} text={products.length ? 'Passe deine Suche oder den Filter an.' : 'Füge dein erstes Produkt hinzu, um deinen Bestand aufzubauen.'} action={!products.length ? <button className="button-secondary" onClick={openNew}><Plus size={15}/> Produkt anlegen</button> : undefined}/>}
              </div>
            </>
          )}

          {section === 'Verkäufe' && (
            <>
              <div className="page-header"><div><div className="overline">ABGESCHLOSSENE TRANSAKTIONEN</div><h1>Verkäufe</h1><p>Behalte Erlöse, Gebühren und tatsächliche Gewinne im Blick.</p></div></div>
              <div className="metric-grid compact-metrics"><Metric icon={<ShoppingBag size={19}/>} label="Verkäufe" value={String(sold.length)} detail="Abgeschlossene Verkäufe" tone="blue"/><Metric icon={<Wallet size={19}/>} label="Umsatz" value={money(revenue)} detail="Vor Abzug der Kosten" tone="violet"/><Metric icon={<TrendingUpIcon/>} label="Realisierter Gewinn" value={money(totalProfit)} detail="Nach erfassten Kosten" tone="green"/><Metric icon={<Truck size={19}/>} label="Gebühren & Versand" value={money(sold.reduce((s,p)=>s+p.fees+p.shipping,0))} detail="Erfasste Verkaufskosten" tone="amber"/></div>
              <section className="panel"><div className="panel-title-row"><div><h2>Verkaufshistorie</h2><p>Alle als verkauft markierten Produkte</p></div></div>{sold.length ? <ProductTable products={sold} onEdit={editProduct} onDelete={deleteProduct} onSell={setSelling} onViewReceipt={viewReceipt}/> : <EmptyState icon={<ShoppingBag size={22}/>} title="Noch keine Verkäufe" text="Ändere bei einem Produkt den Status auf „Verkauft“, um es hier zu sehen." action={<button className="button-secondary" onClick={() => setSection('Produkte')}>Zu den Produkten</button>}/>}</section>
            </>
          )}

          {section === 'Auswertungen' && <section className="panel coming-panel"><div className="coming-icon"><Sparkles size={23}/></div><h2>Auswertungen</h2><p>Hier bauen wir deine Monatsübersichten, Gewinnentwicklung und Plattformvergleiche auf.</p><span className="coming-tag">WIRD ALS NÄCHSTES ERWEITERT</span></section>}
          {section === 'Einstellungen' && <section className="panel settings-panel"><div className="panel-title-row"><div><h2>Lokaler Workspace</h2><p>Die App läuft ohne Konto, Anmeldung oder E-Mail-Versand.</p></div></div><div className="setting-row"><div><strong>Betriebsmodus</strong><span>Persönliche Nutzung auf diesem Gerät.</span></div><span className="setting-pill">Ohne Login</span></div><div className="setting-row"><div><strong>Erscheinungsbild</strong><span>Zwischen dem dunklen Neon-Look und dem hellen Design wechseln.</span></div><button className="setting-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={15}/> : <Moon size={15}/>} {theme === 'dark' ? 'Helles Design' : 'Dark Mode'}</button></div><div className="setting-row"><div><strong>Datenspeicherung</strong><span>Produkte werden nur in diesem Browser gespeichert. Es gibt keine Cloud-Synchronisierung.</span></div><span className="setting-pill">Lokal</span></div><div className="setting-row"><div><strong>Belege</strong><span>PDFs und Bilder werden im lokalen Browserspeicher dieses Geräts abgelegt. Du kannst sie direkt beim jeweiligen Produkt öffnen.</span></div><span className="setting-pill">Auf diesem Gerät</span></div><div className="backup-section"><div className="backup-heading"><div><strong>Backup erstellen</strong><span>Erstellt eine ZIP-Datei mit Produktdaten und Originalbelegen. Auf iPhone/iPad kannst du sie über das Teilen-Menü in „Dateien“ sichern und später hier wieder hochladen.</span></div><HardDrive size={20}/></div><div className="backup-actions"><button className="button-primary" onClick={() => void createBackup()} disabled={backupBusy}><ArrowDownToLine size={15}/>{backupBusy ? 'Bitte warten …' : 'ZIP-Backup erstellen'}</button><button className="button-secondary" onClick={() => backupInput.current?.click()} disabled={backupBusy}><FileUp size={15}/> Backup hochladen</button><input ref={backupInput} type="file" accept=".zip,application/zip,.json,application/json" hidden onChange={e => void restoreBackup(e.target.files?.[0])}/></div>{backupMessage && <p className="backup-message" role="status">{backupMessage}</p>}<small>Beim Wiederherstellen werden die aktuellen Produkte und Belege durch den Inhalt des Backups ersetzt. Alte JSON-Backups werden weiterhin erkannt.</small></div><div className="setting-row"><div><strong>Währung</strong><span>Die Anzeige aller Beträge wird sofort umgestellt.</span></div><select className="setting-select" aria-label="Währung auswählen" value={currency} onChange={e => { const next = e.target.value as Currency; localStorage.setItem(CURRENCY_STORAGE_KEY, next); setCurrency(next) }}><option value="EUR">Euro (€)</option><option value="USD">US-Dollar ($)</option><option value="GBP">Britisches Pfund (£)</option><option value="CHF">Schweizer Franken (CHF)</option></select></div><div className="setting-row"><div><strong>App-Version</strong><span>Reselling Manager – Invoice Studio</span></div><span className="setting-pill">0.4.0 Local</span></div></section>}
          <footer className="page-footer">Reselling Manager <span>·</span> Einfach den Überblick behalten.</footer>
        </div>
      </main>

      {showForm && <ProductModal product={editing} onClose={() => {setShowForm(false);setEditing(null)}} onSave={saveProduct}/>}
      {selling && <SaleModal product={selling} onClose={() => setSelling(null)} onSave={saveSale}/>}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)}/>}
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

function ProductTable({ products, onEdit, onDelete, onSell, onViewReceipt }: {
  products: Product[]
  onEdit: (p: Product) => void
  onDelete: (id: string) => void
  onSell: (p: Product) => void
  onViewReceipt: (path: string) => void
}) {
  return <div className="table-scroll"><table className="product-table"><thead><tr><th>PRODUKT</th><th>STÜCK</th><th>PLATTFORM</th><th>EINKAUF GESAMT</th><th>VERKAUF</th><th>GEWINN</th><th>STATUS</th><th/></tr></thead><tbody>{products.map(p => <tr key={p.id}><td><div className="product-name"><div className="product-thumb">{p.imageUrl ? <img src={p.imageUrl} alt={p.name}/> : <Tag size={16}/>}</div><div><strong>{p.name}</strong><span>{p.category || 'Ohne Kategorie'}</span>{p.receiptPath && <button className="receipt-link" type="button" onClick={() => onViewReceipt(p.receiptPath)}><FileText size={12}/> Beleg ansehen</button>}</div></div></td><td>{p.quantity || 1}</td><td>{p.platform || '–'}</td><td>{money(p.purchasePrice)}</td><td>{p.status === 'Verkauft' ? money(p.salePrice) : '–'}</td><td className={p.status === 'Verkauft' ? (profit(p) >= 0 ? 'positive' : 'negative') : 'table-muted'}>{p.status === 'Verkauft' ? money(profit(p)) : '–'}</td><td><span className={p.status === 'Verkauft' ? 'status-badge sold' : 'status-badge stock'}>{p.status}</span></td><td><div className="row-actions"><button className="sale-action" aria-label={p.status === 'Verkauft' ? 'Verkauf bearbeiten' : 'Verkauf eintragen'} title={p.status === 'Verkauft' ? 'Verkauf bearbeiten' : 'Verkauf eintragen'} onClick={() => onSell(p)}><DollarSign size={14}/><span>{p.status === 'Verkauft' ? 'Anpassen' : 'Verkauf'}</span></button><button aria-label="Bearbeiten" onClick={() => onEdit(p)}><Pencil size={15}/></button><button aria-label="Löschen" onClick={() => onDelete(p.id)}><Trash2 size={15}/></button></div></td></tr>)}</tbody></table></div>
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
      <label className="field full"><span>Verkaufspreis gesamt ({currencySymbol()}) *</span><input autoFocus required type="number" min="0.01" step="0.01" value={salePrice} onChange={event => setSalePrice(event.target.value)} placeholder="z. B. 149,99"/></label>
      <label className="field"><span>Versandkosten ({currencySymbol()})</span><input type="number" min="0" step="0.01" value={shipping} onChange={event => setShipping(event.target.value)}/></label>
      <label className="field"><span>Plattformgebühren ({currencySymbol()})</span><input type="number" min="0" step="0.01" value={fees} onChange={event => setFees(event.target.value)}/></label>
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
      if (extracted.lineItems.length > 1) {
        const initialLines: InvoiceDraftLine[] = extracted.lineItems.map(line => ({
          ...line,
          selected: true,
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
    if (invoiceLines.length > 1) {
      if (!selectedLines.length || selectedLines.some(line => !line.description.trim() || Number(line.quantity) < 1 || Number(line.amount) < 0)) return
    } else if (!name.trim() || purchasePrice === '' || Number(quantity) < 1) {
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
      status: product?.status || 'Auf Lager',
      receiptPath,
    }
    const products: Product[] = invoiceLines.length > 1
      ? selectedLines.map(line => ({
          id: crypto.randomUUID(),
          name: line.description.trim(),
          ...common,
          purchasePrice: Number(line.amount || 0),
          quantity: Math.max(1, Math.floor(Number(line.quantity) || 1)),
          imageUrl: line.imageUrl,
          imageAttribution: line.imageAttribution,
          imageLicense: line.imageLicense,
        }))
      : [{
          id: product?.id || crypto.randomUUID(),
          name: name.trim(),
          ...common,
          purchasePrice: Number(purchasePrice),
          quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
          imageUrl,
          imageAttribution,
          imageLicense,
        }]

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
      {invoiceLines.length > 1 ? <div className="invoice-lines-panel full">
        <div className="invoice-lines-heading"><div><strong>{invoiceLines.length} erkannte Artikel</strong><small>Alle passenden Positionen sind vorausgewählt. Prüfe Namen, Stückzahl und Gesamtpreis je Position.</small></div><span>{selectedLines.length} ausgewählt</span></div>
        {invoiceLines.map(line => <div className="invoice-line-card" key={line.id}>
          <div className="invoice-line-top"><input type="checkbox" checked={line.selected} onChange={e => updateInvoiceLine(line.id,{selected:e.target.checked})}/><input className="invoice-line-name" value={line.description} onChange={e => updateInvoiceLine(line.id,{description:e.target.value})} aria-label="Artikelname"/></div>
          <div className="invoice-line-bottom">
            <label><span>Stück</span><input type="number" min="1" step="1" value={line.quantity} onChange={e => updateInvoiceLine(line.id,{quantity:Number(e.target.value)})}/></label>
            <label><span>Gesamtpreis ({currencySymbol()})</span><input type="number" min="0" step="0.01" value={line.amount} onChange={e => updateInvoiceLine(line.id,{amount:Number(e.target.value)})}/></label>
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
        <label className="field"><span>Stückzahl *</span><input required type="number" min="1" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>
        <label className="field"><span>Einkaufspreis gesamt ({currencySymbol()}) *</span><input required type="number" min="0" step="0.01" value={purchasePrice} onChange={e=>setPurchasePrice(e.target.value)} placeholder="0,00"/></label>
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
    </div><div className="modal-actions"><button type="button" className="button-ghost" onClick={onClose} disabled={saving}>Abbrechen</button><button type="submit" className="button-primary" disabled={saving || scanBusy || (invoiceLines.length > 1 && selectedLines.length === 0)}>{saving ? <LoaderCircle size={15} className="spin"/> : null}{saving ? 'Speichert …' : product ? 'Änderungen speichern' : invoiceLines.length > 1 ? selectedLines.length + ' Produkte hinzufügen' : 'Produkt speichern'}</button></div></form>}
  </div></div>
}



function HelpModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop help-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="modal-card help-card">
    <div className="modal-header"><div><span className="overline">RESSELLMANAGER GUIDE</span><h2>Wie können wir helfen?</h2><p>Die wichtigsten Funktionen auf einen Blick.</p></div><button className="modal-close" onClick={onClose}><X size={19}/></button></div>
    <div className="help-content">
      <div className="help-item"><span><FileUp size={18}/></span><div><strong>Rechnung intelligent erfassen</strong><p>Die lokale Florence-2-KI liest Text und Tabellenpositionen im Browser aus. Mehrere Artikel können einzeln geprüft und gemeinsam als Produkte gespeichert werden. Falls die KI auf dem Gerät nicht läuft, springt die normale Browser-Texterkennung ein. Beim ersten Einsatz wird das KI-Modell einmalig aus dem Internet geladen (mehrere hundert MB).</p></div></div>
      <div className="help-item"><span><ImagePlus size={18}/></span><div><strong>Produktbilder</strong><p>Nach der Rechnungserkennung wird automatisch das bestplatzierte kommerziell nutzbare Bild von Openverse ausgewählt. Über „Bild ändern“ kannst du andere Bilder ansehen. Google Bilder öffnet eine separate Suche; deren erstes Ergebnis kann die App nicht automatisch auslesen.</p></div></div>
      <div className="help-item"><span><Moon size={18}/></span><div><strong>Dark Mode</strong><p>Über das Mond-/Sonnensymbol oben kannst du jederzeit zwischen dunklem und hellem Erscheinungsbild wechseln.</p></div></div>
      <div className="help-item"><span><HardDrive size={18}/></span><div><strong>Lokale Daten</strong><p>Produkte und Originalbelege bleiben im Speicher dieses Browsers auf diesem Gerät. Es gibt keine Anmeldung, keine Cloud-Synchronisierung und keine automatische Sicherung. Für die Bildsuche wird nur der erkannte Produktname an Openverse übermittelt.</p></div></div>
    </div>
    <div className="modal-actions"><button className="button-primary" onClick={onClose}>Alles klar</button></div>
  </section></div>
}

export default App