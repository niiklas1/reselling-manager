import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, CheckCircle2, ChevronDown, Clock3, ExternalLink, LoaderCircle, Package, RefreshCw, ShoppingBag, Store, Unplug } from 'lucide-react'

type EbayStatus = {
  connected: boolean
  connectedAt: string | null
  lastSyncAt: string | null
  lastSyncError: string | null
}
type EbayListing = {
  external_listing_id: string
  title: string
  marketplace: string
  status: string
  listing_format: string | null
  price: number | null
  currency: string | null
  quantity_available: number | null
  quantity_sold: number | null
  listing_url: string
  started_at: string | null
  ended_at: string | null
  last_synced_at: string
}
type EbayOrder = {
  external_order_id: string
  line_item_id: string
  external_listing_id: string | null
  title: string
  quantity: number
  amount: number | null
  currency: string | null
  order_status: string
  sold_at: string | null
}
type Props = { accessToken: string }

function dateLabel(value: string | null): string {
  if (!value) return 'Noch nicht synchronisiert'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '–' : date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}
function priceLabel(value: number | null, currency: string | null): string {
  if (value === null || !currency) return 'Preis nicht verfügbar'
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value)
  } catch {
    return value.toFixed(2) + ' ' + currency
  }
}

export default function EbayIntegrationPanel({ accessToken }: Props) {
  const [status, setStatus] = useState<EbayStatus | null>(null)
  const [listings, setListings] = useState<EbayListing[]>([])
  const [orders, setOrders] = useState<EbayOrder[]>([])
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | ''>('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const request = useCallback(async <T,>(path: string, method = 'GET'): Promise<T> => {
    const response = await fetch(path, {
      method,
      headers: {
        Authorization: 'Bearer ' + accessToken,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    const payload = await response.json().catch(() => ({})) as { error?: string } & T
    if (!response.ok) throw new Error(payload.error || 'Die eBay-Anfrage ist fehlgeschlagen.')
    return payload
  }, [accessToken])

  const load = useCallback(async () => {
    try {
      const current = await request<EbayStatus>('/api/ebay/status')
      setStatus(current)
      if (current.connected) {
        const data = await request<{ listings: EbayListing[]; orders: EbayOrder[] }>('/api/ebay/listings')
        setListings(data.listings || [])
        setOrders(data.orders || [])
      } else {
        setListings([])
        setOrders([])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'eBay-Status konnte nicht geladen werden.')
    }
  }, [request])

  useEffect(() => {
    const url = new URL(window.location.href)
    const result = url.searchParams.get('ebay')
    if (result) {
      setMessage(result === 'connected'
        ? 'Dein eBay-Konto wurde erfolgreich verbunden. Du kannst jetzt den ersten Import starten.'
        : result === 'declined'
          ? 'Die eBay-Freigabe wurde abgebrochen.'
          : 'Die eBay-Verbindung konnte nicht abgeschlossen werden. Prüfe die Einrichtung und versuche es erneut.')
      url.searchParams.delete('ebay')
      window.history.replaceState({}, '', url.pathname + url.hash)
    }
    void load()
  }, [load])

  async function connect() {
    setBusy('connect')
    setError('')
    try {
      const result = await request<{ authorizationUrl: string }>('/api/ebay/connect', 'POST')
      window.location.assign(result.authorizationUrl)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'eBay-Verbindung konnte nicht gestartet werden.')
      setBusy('')
    }
  }

  async function sync() {
    setBusy('sync')
    setError('')
    setMessage('')
    try {
      const result = await request<{ listings: number; orders: number; syncedAt: string; error?: string }>('/api/ebay/sync', 'POST')
      await load()
      setMessage('Synchronisierung abgeschlossen: ' + result.listings + ' Angebote und ' + result.orders + ' Bestellpositionen wurden übernommen.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'eBay-Synchronisierung fehlgeschlagen.')
    } finally {
      setBusy('')
    }
  }

  async function disconnect() {
    if (!window.confirm('eBay wirklich trennen? Die importierten Angebots- und Verkaufsdaten bleiben als lokale Übersicht erhalten.')) return
    setBusy('disconnect')
    setError('')
    try {
      await request('/api/ebay/disconnect', 'POST')
      setStatus({ connected: false, connectedAt: null, lastSyncAt: null, lastSyncError: null })
      setMessage('Die eBay-Verbindung wurde getrennt. Bereits importierte Daten bleiben erhalten.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'eBay konnte nicht getrennt werden.')
    } finally {
      setBusy('')
    }
  }

  const activeCount = listings.filter(item => item.status === 'ACTIVE').length
  const endedCount = listings.filter(item => item.status === 'ENDED' || item.status === 'SOLD').length

  return (
    <details className="gmail-panel ebay-integration-card">
      <summary className="gmail-panel-heading ebay-panel-heading">
        <div>
          <span className="gmail-panel-icon ebay-integration-icon"><Store size={17}/></span>
          <div>
            <strong>eBay</strong>
            <p>Deine eBay-Angebote und Verkäufe automatisch übernehmen.</p>
          </div>
        </div>
        <span className={status?.connected ? 'integration-status is-connected' : 'integration-status is-disconnected'}>
          <i/>{status?.connected ? 'Verbunden' : 'Nicht verbunden'}
        </span>
        <ChevronDown size={16} className="gmail-chevron"/>
      </summary>
      <div className="gmail-panel-content ebay-panel-content">
      {!status?.connected ? (
        <div className="ebay-connect-content">
          <p>Verbinde dein eBay-Konto einmalig. Danach kann der Reselling Manager aktive Angebote, beendete Angebote und bezahlte Bestellungen auslesen. Dein eBay-Passwort wird nicht in der App gespeichert.</p>
          <button className="button-primary" type="button" onClick={() => void connect()} disabled={busy !== ''}>
            {busy === 'connect' ? <LoaderCircle size={15} className="spin"/> : <ExternalLink size={15}/>}
            Mit eBay verbinden
          </button>
          <small>Voraussetzung: eBay-Developer-App und sichere Worker-Schlüssel müssen eingerichtet sein.</small>
        </div>
      ) : (
        <>
          <div className="ebay-metrics">
            <div><span>Aktive Angebote</span><strong>{activeCount}</strong></div>
            <div><span>Beendete Angebote</span><strong>{endedCount}</strong></div>
            <div><span>Verkäufe importiert</span><strong>{orders.length}</strong></div>
          </div>
          <div className="ebay-sync-row">
            <span><Clock3 size={14}/> Letzter Abgleich: {dateLabel(status.lastSyncAt)}</span>
            <div>
              <button className="button-secondary" type="button" onClick={() => void sync()} disabled={busy !== ''}>
                {busy === 'sync' ? <LoaderCircle size={14} className="spin"/> : <RefreshCw size={14}/>}
                Jetzt synchronisieren
              </button>
              <button className="button-ghost" type="button" onClick={() => void disconnect()} disabled={busy !== ''} title="eBay-Verbindung trennen"><Unplug size={14}/></button>
            </div>
          </div>
          <p className="ebay-automatic-note"><CheckCircle2 size={14}/> Automatischer Abgleich alle sechs Stunden. Du kannst jederzeit manuell aktualisieren.</p>
          {listings.length > 0 && (
            <div className="ebay-import-list">
              <div className="ebay-list-heading"><strong>Importierte Angebote</strong><span>{listings.length} Einträge</span></div>
              {listings.slice(0, 8).map(item => (
                <div className="ebay-listing-row" key={item.external_listing_id}>
                  <div className="ebay-listing-info">
                    <a href={item.listing_url} target="_blank" rel="noreferrer">{item.title || 'eBay-Angebot'} <ArrowUpRight size={12}/></a>
                    <span>{item.external_listing_id} · {item.status === 'ACTIVE' ? 'Aktiv' : item.status === 'SCHEDULED' ? 'Geplant' : item.status === 'SOLD' ? 'Verkauft' : 'Beendet'}</span>
                  </div>
                  <strong>{priceLabel(item.price, item.currency)}</strong>
                </div>
              ))}
              {listings.length > 8 && <small className="ebay-more-note">Weitere {listings.length - 8} Angebote wurden ebenfalls importiert.</small>}
            </div>
          )}
          {orders.length > 0 && (
            <div className="ebay-import-list">
              <div className="ebay-list-heading"><strong>Letzte Verkäufe</strong><span>{orders.length} Positionen</span></div>
              {orders.slice(0, 5).map(item => (
                <div className="ebay-listing-row" key={item.external_order_id + item.line_item_id}>
                  <div className="ebay-listing-info">
                    <span className="ebay-order-title">{item.title}</span>
                    <span>{dateLabel(item.sold_at)} · Menge {item.quantity}</span>
                  </div>
                  <strong>{priceLabel(item.amount, item.currency)}</strong>
                </div>
              ))}
            </div>
          )}
          {!listings.length && !orders.length && <div className="ebay-empty"><Package size={18}/> Noch keine Angebote importiert. Starte den ersten Abgleich.</div>}
        </>
      )}

      {status?.lastSyncError && <p className="ebay-error" role="alert">{status.lastSyncError}</p>}
      {error && <p className="ebay-error" role="alert">{error}</p>}
      {message && <p className="ebay-message" role="status">{message}</p>}
      <div className="ebay-setup-links">
        <a href="https://developer.ebay.com/my/keys" target="_blank" rel="noreferrer">eBay Developer Keys <ExternalLink size={11}/></a>
        <a href="https://developer.ebay.com/develop/guides/sell/authorization" target="_blank" rel="noreferrer">OAuth-Einrichtung <ExternalLink size={11}/></a>
      </div>
      </div>
    </details>
  )
}
