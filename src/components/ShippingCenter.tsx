import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, ExternalLink, LoaderCircle,
  MapPin, PackageCheck, RefreshCw, Truck,
} from 'lucide-react'

type ShippingProduct = {
  id: string
  name: string
  status: 'Auf Lager' | 'Verkauft'
  purchaseDate?: string
  saleDate?: string
  incomingCarrier?: string
  incomingTrackingNumber?: string
  incomingTrackingUrl?: string
  outgoingCarrier?: string
  outgoingTrackingNumber?: string
  outgoingTrackingUrl?: string
}

type TrackingRow = {
  id: string
  product_id: string
  direction: 'incoming' | 'outgoing'
  tracking_number: string
  carrier: string
  tracking_url: string
  provider_registered: boolean
  provider_carrier: number | null
  tracking_status: string
  provider_status: string | null
  provider_sub_status: string | null
  latest_event: string | null
  latest_location: string | null
  latest_event_at: string | null
  estimated_delivery_from: string | null
  estimated_delivery_to: string | null
  last_synced_at: string | null
  tracking_error: string | null
}

type ApiStatus = {
  apiAvailable: boolean
  webhookConfigured: boolean
  liveTrackingEnabled: boolean
  provider: string
  trackings: TrackingRow[]
}

type Props = { products: ShippingProduct[]; accessToken: string; userId: string }

type DisplayShipment = {
  id: string
  productId: string
  productName: string
  direction: 'incoming' | 'outgoing'
  trackingNumber: string
  carrier: string
  trackingUrl: string
  saleDate?: string
  row?: TrackingRow
}

const STATUS_META: Record<string, { label: string; tone: string; icon: 'check' | 'truck' | 'alert' | 'clock' }> = {
  delivered: { label: 'Zugestellt', tone: 'success', icon: 'check' },
  in_transit: { label: 'Unterwegs', tone: 'info', icon: 'truck' },
  out_for_delivery: { label: 'In Zustellung', tone: 'info', icon: 'truck' },
  available_for_pickup: { label: 'Abholbereit', tone: 'warning', icon: 'clock' },
  label_created: { label: 'Sendung angekündigt', tone: 'neutral', icon: 'clock' },
  attention: { label: 'Problem / Verzögerung', tone: 'danger', icon: 'alert' },
  stale: { label: 'Keine neuen Scans', tone: 'warning', icon: 'clock' },
  returned: { label: 'Rücksendung', tone: 'warning', icon: 'alert' },
  not_found: { label: 'Noch keine Daten', tone: 'neutral', icon: 'clock' },
  unknown: { label: 'Status offen', tone: 'neutral', icon: 'clock' },
}

function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}

function trackingLink(shipment: DisplayShipment): string {
  if (shipment.trackingUrl.startsWith('https://')) return shipment.trackingUrl
  return 'https://t.17track.net/en#nums=' + encodeURIComponent(shipment.trackingNumber)
}

async function readPayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error || 'Die Versanddaten konnten nicht geladen werden.')
  return payload
}

function statusMeta(status: string) {
  return STATUS_META[status] || STATUS_META.unknown
}

function ShipmentCard({ shipment, liveTrackingEnabled }: {
  shipment: DisplayShipment
  liveTrackingEnabled: boolean
}) {
  const row = shipment.row
  const status = row?.tracking_status || (liveTrackingEnabled ? 'not_found' : 'unknown')
  const meta = statusMeta(status)
  const icon = meta.icon === 'check' ? <CheckCircle2 size={15}/>
    : meta.icon === 'alert' ? <AlertTriangle size={15}/>
      : meta.icon === 'truck' ? <Truck size={15}/>
        : <Clock3 size={15}/>

  return (
    <article className="shipping-shipment-card">
      <div className="shipping-shipment-main">
        <div className={'shipping-shipment-icon ' + (shipment.direction === 'outgoing' ? 'outgoing' : 'incoming')}>
          {shipment.direction === 'outgoing' ? <Truck size={18}/> : <PackageCheck size={18}/>}
        </div>
        <div className="shipping-shipment-copy">
          <strong>{shipment.productName || 'Unbenanntes Produkt'}</strong>
          <span>{shipment.direction === 'incoming' ? 'Eingehender Versand · Einkauf' : 'Ausgehender Versand · Verkauf'}</span>
          <small>{shipment.carrier || 'Paketdienst nicht erkannt'} · {shipment.trackingNumber}</small>
        </div>
        <span className={'shipping-status-pill tone-' + meta.tone}>{icon}{meta.label}</span>
      </div>

      {row?.latest_event && (
        <div className="shipping-latest-event">
          <span>{row.latest_event}</span>
          {row.latest_location && <small><MapPin size={12}/>{row.latest_location}</small>}
          {row.latest_event_at && <small><Clock3 size={12}/>{formatDate(row.latest_event_at)}</small>}
        </div>
      )}

      {row?.tracking_error && (
        <p className="shipping-row-error"><AlertTriangle size={13}/>{row.tracking_error}</p>
      )}

      <div className="shipping-shipment-footer">
        <span>
          {row?.estimated_delivery_from
            ? 'Voraussichtlich ' + formatDate(row.estimated_delivery_from).split(',')[0] +
              (row.estimated_delivery_to ? ' – ' + formatDate(row.estimated_delivery_to).split(',')[0] : '')
            : row?.last_synced_at
              ? 'Zuletzt aktualisiert ' + formatDate(row.last_synced_at)
              : liveTrackingEnabled
                ? row?.provider_registered ? 'Warte auf erste Statusmeldung' : 'Wird für Live-Tracking registriert'
                : 'Live-Status noch nicht eingerichtet'}
        </span>
        <a href={trackingLink(shipment)} target="_blank" rel="noreferrer">
          Sendung öffnen <ExternalLink size={13}/>
        </a>
      </div>
    </article>
  )
}

export default function ShippingCenter({ products, accessToken, userId }: Props) {
  const [apiStatus, setApiStatus] = useState<ApiStatus>({
    apiAvailable: false,
    webhookConfigured: false,
    liveTrackingEnabled: false,
    provider: '17TRACK',
    trackings: [],
  })
  const [filter, setFilter] = useState<'all' | 'incoming' | 'outgoing'>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadStatus = useCallback(async () => {
    const response = await fetch('/api/shipping/status', {
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    })
    const payload = await readPayload<ApiStatus>(response)
    setApiStatus(payload)
    return payload.apiAvailable
  }, [accessToken])

  const refresh = useCallback(async (silent = false, forceRefresh = false) => {
    if (!silent) setSyncing(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/api/shipping/sync', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ forceRefresh }),
      })
      const result = await readPayload<{ registered: number; updated: number; total: number }>(response)
      await loadStatus()
      if (!silent) {
        setMessage(result.registered > 0
          ? result.registered + ' neue Sendung(en) registriert und ' + result.updated + ' Status abgeglichen.'
          : result.updated + ' Sendungsstatus aktualisiert.')
      }
    } catch (cause) {
      if (!silent) setError(cause instanceof Error ? cause.message : 'Die Sendungen konnten nicht aktualisiert werden.')
    } finally {
      if (!silent) setSyncing(false)
    }
  }, [accessToken, loadStatus])

  useEffect(() => {
    let active = true
    const initialise = async () => {
      setLoading(true)
      try {
        const configured = await loadStatus()
        if (active && configured) await refresh(true)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Die Versandübersicht konnte nicht geladen werden.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void initialise()
    const channel = supabase.channel('shipping-trackings-' + userId)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'shipping_trackings',
        filter: 'user_id=eq.' + userId,
      }, () => { void loadStatus() })
      .subscribe()
    return () => {
      active = false
      void supabase.removeChannel(channel)
    }
  }, [loadStatus, refresh, userId])

  const shipments = useMemo<DisplayShipment[]>(() => {
    const trackingByKey = new Map(apiStatus.trackings.map(row => [row.product_id + ':' + row.direction, row]))
    return products.flatMap(product => {
      const entries: DisplayShipment[] = []
      if (product.incomingTrackingNumber?.trim()) {
        entries.push({
          id: product.id + ':incoming',
          productId: product.id,
          productName: product.name,
          direction: 'incoming',
          trackingNumber: product.incomingTrackingNumber.trim(),
          carrier: product.incomingCarrier || '',
          trackingUrl: product.incomingTrackingUrl || '',
          row: trackingByKey.get(product.id + ':incoming'),
        })
      }
      if (product.outgoingTrackingNumber?.trim()) {
        entries.push({
          id: product.id + ':outgoing',
          productId: product.id,
          productName: product.name,
          direction: 'outgoing',
          trackingNumber: product.outgoingTrackingNumber.trim(),
          carrier: product.outgoingCarrier || '',
          trackingUrl: product.outgoingTrackingUrl || '',
          saleDate: product.saleDate,
          row: trackingByKey.get(product.id + ':outgoing'),
        })
      }
      return entries
    })
  }, [products, apiStatus.trackings])

  const visibleShipments = useMemo(() => shipments.filter(shipment => {
    if (filter !== 'all' && shipment.direction !== filter) return false
    const haystack = [shipment.productName, shipment.carrier, shipment.trackingNumber].join(' ').toLocaleLowerCase('de-DE')
    return !search.trim() || haystack.includes(search.trim().toLocaleLowerCase('de-DE'))
  }), [shipments, filter, search])

  const count = (statuses: string[]) => shipments.filter(shipment => statuses.includes(
    shipment.row?.tracking_status || (apiStatus.liveTrackingEnabled ? 'not_found' : 'unknown')
  )).length

  return (
    <section className="shipping-center-page">
      <div className="shipping-center-header">
        <div>
          <span className="overline">VERSAND & SENDUNGSVERFOLGUNG</span>
          <h1>Versandzentrale</h1>
          <p>Alle eingehenden und ausgehenden Sendungen an einem Ort – inklusive Status und letzter Paketbewegung.</p>
        </div>
        <button className="button-secondary shipping-refresh-button" type="button" onClick={() => void refresh(false, true)} disabled={syncing || !apiStatus.apiAvailable}>
          {syncing ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}
          Aktualisieren
        </button>
      </div>

      <div className={'shipping-provider-banner ' + (apiStatus.liveTrackingEnabled ? 'is-active' : 'is-pending')}>
        <div className="shipping-provider-symbol"><Truck size={19}/></div>
        <div>
          <strong>{apiStatus.liveTrackingEnabled ? 'Live-Tracking ist aktiviert' : 'Sendungen werden angezeigt – Live-Tracking noch nicht verbunden'}</strong>
          <span>{apiStatus.liveTrackingEnabled
            ? '17TRACK übermittelt Statusänderungen automatisch. Neue Sendungsnummern werden beim Öffnen dieser Seite registriert.'
            : apiStatus.apiAvailable
              ? 'Die API ist verbunden. Automatische Statusmeldungen benötigen noch die Webhook-Sicherheitskonfiguration; du kannst den Status jederzeit manuell aktualisieren.'
              : 'Deine vorhandenen Sendungsnummern aus Produkten und Gmail werden hier gesammelt. Für echte Paketstatus benötigen wir noch den 17TRACK-API-Schlüssel im Cloudflare Worker.'}</span>
        </div>
        <span className={'shipping-provider-state ' + (apiStatus.liveTrackingEnabled ? 'is-active' : 'is-pending')}>
          <i/>{apiStatus.liveTrackingEnabled ? 'Verbunden' : 'Einrichtung offen'}
        </span>
      </div>

      <div className="shipping-metric-grid">
        <div className="shipping-metric-card"><span>Alle Sendungen</span><strong>{shipments.length}</strong><small>Eingehend und ausgehend</small></div>
        <div className="shipping-metric-card"><span>Unterwegs</span><strong>{count(['in_transit', 'out_for_delivery'])}</strong><small>Aktive Transporte</small></div>
        <div className="shipping-metric-card"><span>Zugestellt</span><strong>{count(['delivered'])}</strong><small>Erfolgreich angekommen</small></div>
        <div className="shipping-metric-card"><span>Probleme</span><strong>{count(['attention', 'stale'])}</strong><small>Prüfung empfohlen</small></div>
      </div>

      <div className="shipping-list-panel">
        <div className="shipping-list-toolbar">
          <div>
            <h2>Sendungsübersicht</h2>
            <p>{visibleShipments.length} von {shipments.length} Sendungen</p>
          </div>
          <div className="shipping-list-controls">
            <div className="shipping-filter-group" role="group" aria-label="Sendungen filtern">
              <button className={filter === 'all' ? 'active' : ''} type="button" onClick={() => setFilter('all')}>Alle</button>
              <button className={filter === 'incoming' ? 'active' : ''} type="button" onClick={() => setFilter('incoming')}>Eingehend</button>
              <button className={filter === 'outgoing' ? 'active' : ''} type="button" onClick={() => setFilter('outgoing')}>Ausgehend</button>
            </div>
            <input className="shipping-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Produkt oder Sendungsnummer suchen …" aria-label="Sendungen suchen"/>
          </div>
        </div>

        {error && <p className="shipping-feedback is-error" role="alert"><AlertTriangle size={14}/>{error}</p>}
        {message && <p className="shipping-feedback is-success" role="status"><CheckCircle2 size={14}/>{message}</p>}

        {loading ? (
          <div className="shipping-empty-state"><LoaderCircle size={23} className="spin"/><strong>Sendungen werden geladen …</strong></div>
        ) : visibleShipments.length ? (
          <div className="shipping-shipment-list">
            {visibleShipments.map(shipment => <ShipmentCard key={shipment.id} shipment={shipment} liveTrackingEnabled={apiStatus.liveTrackingEnabled}/>)}
          </div>
        ) : (
          <div className="shipping-empty-state">
            <PackageCheck size={27}/>
            <strong>{shipments.length ? 'Keine passenden Sendungen gefunden' : 'Noch keine Sendungen vorhanden'}</strong>
            <p>{shipments.length
              ? 'Ändere den Filter oder den Suchbegriff.'
              : 'Sobald du bei einem Produkt eine eingehende oder ausgehende Sendungsnummer hinterlegst – auch über den Gmail-Versandimport – erscheint sie automatisch hier.'}</p>
          </div>
        )}
      </div>
    </section>
  )
}

export function ShippingTrackingIntegrationPanel({ accessToken }: { accessToken: string }) {
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch('/api/shipping/status', {
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    }).then(readPayload<ApiStatus>).then(payload => {
      if (active) setApiStatus(payload)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Tracking-Status konnte nicht geladen werden.')
    })
    return () => { active = false }
  }, [accessToken])

  const connected = Boolean(apiStatus?.liveTrackingEnabled)
  return (
    <details className="gmail-panel shipping-integration-panel">
      <summary className="gmail-panel-heading">
        <div>
          <span className="gmail-panel-icon"><Truck size={17}/></span>
          <div>
            <strong>17TRACK Live-Tracking</strong>
            <p>Sendungsstatus, Paketbewegungen und Zustellprobleme automatisch erkennen.</p>
          </div>
        </div>
        <span className={connected ? 'integration-status is-connected' : 'integration-status is-disconnected'}>
          <i/>{connected ? 'Verbunden' : 'Einrichtung offen'}
        </span>
        <span className="gmail-chevron"><ArrowUpRight size={15}/></span>
      </summary>
      <div className="gmail-panel-content shipping-integration-content">
        <p>{connected
          ? 'Die Tracking-API und der Webhook sind konfiguriert. Statusänderungen werden automatisch in der Versandzentrale angezeigt.'
          : 'Die Versandzentrale sammelt bereits deine gespeicherten Sendungsnummern. Für Live-Statusmeldungen müssen API-Token und Webhook-Sicherheitsschlüssel von 17TRACK als Cloudflare Worker Secrets hinterlegt werden.'}</p>
        {error && <p className="shipping-feedback is-error">{error}</p>}
        <div className="shipping-integration-links">
          <a href="https://api.17track.net/" target="_blank" rel="noreferrer">17TRACK API-Konto erstellen <ExternalLink size={12}/></a>
          <a href="https://api.17track.net/en/doc" target="_blank" rel="noreferrer">API-Dokumentation <ExternalLink size={12}/></a>
        </div>
        <small>Der API-Schlüssel wird nicht im Browser gespeichert. Er wird erst nach sicherer Einrichtung auf dem Worker-Server verwendet.</small>
      </div>
    </details>
  )
}
