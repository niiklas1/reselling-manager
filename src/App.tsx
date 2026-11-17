import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine, ArrowUpRight, Bell, Box, ChartNoAxesCombined, ChevronDown,
  CircleHelp, LayoutDashboard, Menu, Package, Plus, Search, Settings,
  ShoppingBag, SlidersHorizontal, Sparkles, Wallet, X, Trash2, Pencil,
  CalendarDays, Tag, Truck, CheckCircle2, LogOut, Mail, LockKeyhole, LoaderCircle,
  Camera, FileText, FileUp, ImagePlus, Moon, Sun, ExternalLink, RefreshCw
} from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import { readInvoiceFile } from './lib/invoiceScanner'
import { searchProductImages, type ProductImageResult } from './lib/productImages'

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

const initialProducts: Product[] = []

const money = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value)
const profit = (p: Product) => p.salePrice - p.purchasePrice - p.shipping - p.fees

function mapProductRow(row: any): Product {
  return {
    id: row.id,
    name: row.name,
    category: row.category || '',
    platform: row.platform || '',
    purchasePrice: Number(row.purchase_price || 0),
    salePrice: Number(row.sale_price || 0),
    shipping: Number(row.shipping || 0),
    fees: Number(row.fees || 0),
    purchaseDate: row.purchase_date || '',
    saleDate: row.sale_date || '',
    status: row.status as Status,
    quantity: Number(row.quantity || 1),
    imageUrl: row.image_url || '',
    imageAttribution: row.image_attribution || '',
    imageLicense: row.image_license || '',
    receiptPath: row.receipt_path || '',
  }
}

function App() {
  const [section, setSection] = useState<Section>('Übersicht')
  const [session, setSession] = useState<Session | null>(null)
  const [passwordRecovery, setPasswordRecovery] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const [productsLoading, setProductsLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'Alle' | Status>('Alle')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('reselling-theme')
    return saved === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('reselling-theme', theme)
  }, [theme])

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return
      if (error) setDataError(error.message)
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true)
      setSession(nextSession)
      setAuthLoading(false)
    })
    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const userId = session?.user.id
    if (!userId) {
      setProducts([])
      setProductsLoading(false)
      return
    }

    let cancelled = false
    const loadProducts = async () => {
      setProductsLoading(true)
      setDataError('')
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('created_at', { ascending: false })

      if (cancelled) return
      if (error) {
        setDataError(`Deine Produkte konnten nicht geladen werden: ${error.message}`)
        setProductsLoading(false)
        return
      }

      let rows = data || []
      if (rows.length === 0) {
        try {
          const legacy = JSON.parse(localStorage.getItem('reselling-products') || '[]') as Product[]
          if (Array.isArray(legacy) && legacy.length > 0 && window.confirm(`Du hast noch ${legacy.length} lokal gespeicherte Produkte aus der alten App. Möchtest du sie in diesen Account übernehmen?`)) {
            const importRows = legacy.map((p) => ({
              user_id: userId,
              name: p.name,
              category: p.category || '',
              platform: p.platform || '',
              purchase_price: Number(p.purchasePrice || 0),
              sale_price: Number(p.salePrice || 0),
              shipping: Number(p.shipping || 0),
              fees: Number(p.fees || 0),
              purchase_date: p.purchaseDate || null,
              sale_date: p.saleDate || null,
              status: p.status || 'Auf Lager',
            }))
            const { data: imported, error: importError } = await supabase.from('products').insert(importRows).select('*').order('created_at', { ascending: false })
            if (importError) setDataError(`Die alten Produkte konnten nicht importiert werden: ${importError.message}`)
            else rows = imported || []
          }
        } catch {
          // Ignore invalid legacy browser data and keep the account's cloud inventory empty.
        }
      }

      if (cancelled) return
      setProducts(rows.map(mapProductRow))
      setProductsLoading(false)
    }

    void loadProducts()
    return () => { cancelled = true }
  }, [session?.user.id])


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

  async function saveProduct(product: Product, invoiceFile?: File | null): Promise<boolean> {
    if (!session?.user.id) return false
    setDataError('')
    let receiptPath = product.receiptPath || null
    let newlyUploadedPath = ''

    if (invoiceFile) {
      const safeName = invoiceFile.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90)
      newlyUploadedPath = session.user.id + '/' + product.id + '/' + Date.now() + '-' + safeName
      const { error: uploadError } = await supabase.storage
        .from('product-invoices')
        .upload(newlyUploadedPath, invoiceFile, { contentType: invoiceFile.type || 'application/octet-stream', upsert: false })
      if (uploadError) {
        setDataError('Der Beleg konnte nicht gespeichert werden: ' + uploadError.message)
        return false
      }
      receiptPath = newlyUploadedPath
    }

    const payload = {
      user_id: session.user.id,
      name: product.name,
      category: product.category,
      platform: product.platform,
      purchase_price: product.purchasePrice,
      sale_price: product.salePrice,
      shipping: product.shipping,
      fees: product.fees,
      purchase_date: product.purchaseDate || null,
      sale_date: product.saleDate || null,
      status: product.status,
      quantity: product.quantity,
      image_url: product.imageUrl || null,
      image_attribution: product.imageAttribution || null,
      image_license: product.imageLicense || null,
      receipt_path: receiptPath,
    }
    const result = editing
      ? await supabase.from('products').update(payload).eq('id', product.id).select('*').single()
      : await supabase.from('products').insert({ id: product.id, ...payload }).select('*').single()

    if (result.error) {
      if (newlyUploadedPath) await supabase.storage.from('product-invoices').remove([newlyUploadedPath])
      setDataError('Produkt konnte nicht gespeichert werden: ' + result.error.message)
      return false
    }
    const saved = mapProductRow(result.data)
    setProducts(current => editing
      ? current.map(p => p.id === saved.id ? saved : p)
      : [saved, ...current])
    setShowForm(false)
    setEditing(null)
    return true
  }

  function editProduct(product: Product) { setEditing(product); setShowForm(true) }
  async function deleteProduct(id: string) {
    if (!window.confirm('Möchtest du dieses Produkt wirklich löschen?')) return
    const productToDelete = products.find(product => product.id === id)
    const { error } = await supabase.from('products').delete().eq('id', id)
    if (error) {
      setDataError(`Produkt konnte nicht gelöscht werden: ${error.message}`)
      return
    }
    if (productToDelete?.receiptPath) {
      await supabase.storage.from('product-invoices').remove([productToDelete.receiptPath])
    }
    setProducts(current => current.filter(p => p.id !== id))
  }
  function openNew() { setEditing(null); setShowForm(true) }
  async function signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) setDataError(`Abmeldung fehlgeschlagen: ${error.message}`)
  }


  if (authLoading) {
    return <div className="auth-loading"><LoaderCircle className="spin" size={24}/><span>Reselling Manager wird geladen …</span></div>
  }
  if (passwordRecovery) return <PasswordRecoveryScreen onComplete={() => setPasswordRecovery(false)} />
  if (!session) return <AuthScreen />

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
        <button className="profile-card" onClick={() => { setSection('Einstellungen'); setMobileNav(false) }} title="Konto und Einstellungen öffnen"><div className="profile-avatar">N</div><div className="profile-copy"><strong>Mein Workspace</strong><span>{session.user.email}</span></div><ChevronDown size={15} className="profile-chevron"/></button>
        <div className="sidebar-foot">RESSELLMANAGER <span>·</span> V 0.1</div>
      </aside>

      {mobileNav && <button className="mobile-backdrop" aria-label="Menü schließen" onClick={() => setMobileNav(false)}/>}

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={20}/></button>
          <div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{section}</strong></div>
          <div className="topbar-right"><span className="local-status"><i/> Cloud synchronisiert</span><button className="top-icon" aria-label="Hilfe" title="Hilfe" onClick={() => setShowHelp(true)}><CircleHelp size={18}/></button><button className="theme-toggle" aria-label={theme === 'dark' ? 'Helles Design aktivieren' : 'Dark Mode aktivieren'} title={theme === 'dark' ? 'Helles Design' : 'Dark Mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}</button><span className="account-email">{session.user.email}</span><button className="top-avatar top-avatar-button" onClick={() => setSection('Einstellungen')} title="Konto und Einstellungen">N</button><button className="signout-button" onClick={signOut}><LogOut size={14}/><span>Abmelden</span></button></div>
        </header>

        <div className="page-wrap">
          {dataError && <div className="app-alert error" role="alert">{dataError}</div>}
          {productsLoading && <div className="app-alert">Deine Cloud-Daten werden geladen …</div>}
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
                {products.length === 0 ? <EmptyState icon={<Package size={22}/>} title="Dein Reselling startet hier" text="Lege dein erstes Produkt an und behalte Einkauf, Verkauf und Gewinn im Blick." action={<button className="button-secondary" onClick={openNew}><Plus size={15}/> Erstes Produkt anlegen</button>}/> : <ProductTable products={products.slice(0, 5)} onEdit={editProduct} onDelete={deleteProduct}/>}
              </section>
            </>
          )}

          {section === 'Produkte' && (
            <>
              <div className="page-header"><div><div className="overline">INVENTAR VERWALTEN</div><h1>Produkte</h1><p>Verwalte deine Einkäufe, Bestände und Verkäufe.</p></div><button className="button-primary" onClick={openNew}><Plus size={17}/> Produkt hinzufügen</button></div>
              <div className="panel inventory-panel"><div className="inventory-toolbar"><div className="search-box"><Search size={17}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Produkte suchen..."/></div><div className="filter-control"><SlidersHorizontal size={16}/><select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option>Alle</option><option>Auf Lager</option><option>Verkauft</option></select></div></div>
                {visibleProducts.length ? <ProductTable products={visibleProducts} onEdit={editProduct} onDelete={deleteProduct}/> : <EmptyState icon={<Package size={22}/>} title={products.length ? 'Keine Produkte gefunden' : 'Noch keine Produkte vorhanden'} text={products.length ? 'Passe deine Suche oder den Filter an.' : 'Füge dein erstes Produkt hinzu, um deinen Bestand aufzubauen.'} action={!products.length ? <button className="button-secondary" onClick={openNew}><Plus size={15}/> Produkt anlegen</button> : undefined}/>}
              </div>
            </>
          )}

          {section === 'Verkäufe' && (
            <>
              <div className="page-header"><div><div className="overline">ABGESCHLOSSENE TRANSAKTIONEN</div><h1>Verkäufe</h1><p>Behalte Erlöse, Gebühren und tatsächliche Gewinne im Blick.</p></div></div>
              <div className="metric-grid compact-metrics"><Metric icon={<ShoppingBag size={19}/>} label="Verkäufe" value={String(sold.length)} detail="Abgeschlossene Verkäufe" tone="blue"/><Metric icon={<Wallet size={19}/>} label="Umsatz" value={money(revenue)} detail="Vor Abzug der Kosten" tone="violet"/><Metric icon={<TrendingUpIcon/>} label="Realisierter Gewinn" value={money(totalProfit)} detail="Nach erfassten Kosten" tone="green"/><Metric icon={<Truck size={19}/>} label="Gebühren & Versand" value={money(sold.reduce((s,p)=>s+p.fees+p.shipping,0))} detail="Erfasste Verkaufskosten" tone="amber"/></div>
              <section className="panel"><div className="panel-title-row"><div><h2>Verkaufshistorie</h2><p>Alle als verkauft markierten Produkte</p></div></div>{sold.length ? <ProductTable products={sold} onEdit={editProduct} onDelete={deleteProduct}/> : <EmptyState icon={<ShoppingBag size={22}/>} title="Noch keine Verkäufe" text="Ändere bei einem Produkt den Status auf „Verkauft“, um es hier zu sehen." action={<button className="button-secondary" onClick={() => setSection('Produkte')}>Zu den Produkten</button>}/>}</section>
            </>
          )}

          {section === 'Auswertungen' && <section className="panel coming-panel"><div className="coming-icon"><Sparkles size={23}/></div><h2>Auswertungen</h2><p>Hier bauen wir deine Monatsübersichten, Gewinnentwicklung und Plattformvergleiche auf.</p><span className="coming-tag">WIRD ALS NÄCHSTES ERWEITERT</span></section>}
          {section === 'Einstellungen' && <section className="panel settings-panel"><div className="panel-title-row"><div><h2>Konto & Einstellungen</h2><p>Dein persönlicher Workspace und das Erscheinungsbild.</p></div></div><div className="setting-row"><div><strong>Angemeldet als</strong><span>{session.user.email}</span></div><span className="setting-pill">Persönlich</span></div><div className="setting-row"><div><strong>Erscheinungsbild</strong><span>Zwischen dem dunklen Neon-Look und dem hellen Design wechseln.</span></div><button className="setting-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={15}/> : <Moon size={15}/>} {theme === 'dark' ? 'Helles Design' : 'Dark Mode'}</button></div><div className="setting-row"><div><strong>Datenspeicherung</strong><span>Deine Produkte und Belege werden in deinem persönlichen Cloud-Account gespeichert.</span></div><span className="setting-pill">Cloud</span></div><div className="setting-row"><div><strong>Währung</strong><span>Alle Beträge werden in Euro angezeigt.</span></div><span className="setting-pill">EUR (€)</span></div><div className="setting-row"><div><strong>App-Version</strong><span>Reselling Manager – Invoice Studio</span></div><span className="setting-pill">0.2.0</span></div></section>}
          <footer className="page-footer">Reselling Manager <span>·</span> Einfach den Überblick behalten.</footer>
        </div>
      </main>

      {showForm && <ProductModal product={editing} userId={session.user.id} onClose={() => {setShowForm(false);setEditing(null)}} onSave={saveProduct}/>}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)}/>}
    </div>
  )
}


function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setMessage('')
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) {
      setError('Bitte gib deine E-Mail-Adresse ein.')
      return
    }
    if (mode !== 'reset' && password.length < 8) {
      setError('Dein Passwort muss mindestens 8 Zeichen lang sein.')
      return
    }
    if (mode === 'signup' && password !== confirmPassword) {
      setError('Die beiden Passwörter stimmen nicht überein.')
      return
    }

    setBusy(true)
    try {
      if (mode === 'login') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password })
        if (authError) throw authError
      } else if (mode === 'signup') {
        const { data, error: authError } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: { emailRedirectTo: window.location.origin },
        })
        if (authError) throw authError
        if (data.session) {
          setMessage('Dein Account wurde erstellt. Du bist jetzt angemeldet.')
        } else {
          setMessage('Fast geschafft! Bitte bestätige deine E-Mail-Adresse über den Link in deinem Posteingang. Danach kannst du dich anmelden.')
        }
        setMode('login')
        setPassword('')
        setConfirmPassword('')
      } else {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
          redirectTo: window.location.origin,
        })
        if (authError) throw authError
        setMessage('Wenn ein Account zu dieser Adresse existiert, erhältst du eine E-Mail zum Zurücksetzen des Passworts.')
        setMode('login')
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Es ist ein unbekannter Fehler aufgetreten.'
      setError(text)
    } finally {
      setBusy(false)
    }
  }

  const isSignup = mode === 'signup'
  const isReset = mode === 'reset'

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand"><div className="brand-symbol">r.</div><span>resell<span className="brand-muted">manager</span></span></div>
        <div className="auth-heading">
          <div className="overline">{isSignup ? 'NEU HIER?' : isReset ? 'ACCOUNT WIEDERHERSTELLEN' : 'WILLKOMMEN ZURÜCK'}</div>
          <h1>{isSignup ? 'Account erstellen' : isReset ? 'Passwort zurücksetzen' : 'Anmelden'}</h1>
          <p>{isSignup ? 'Erstelle deinen persönlichen Reselling-Workspace.' : isReset ? 'Wir senden dir einen Link zum Zurücksetzen.' : 'Melde dich an, um deine Produkte und Verkäufe zu verwalten.'}</p>
        </div>
        {message && <div className="auth-message success" role="status">{message}</div>}
        {error && <div className="auth-message error" role="alert">{error}</div>}
        <form className="auth-form" onSubmit={submit}>
          <label className="field"><span>E-Mail-Adresse</span><div className="auth-input-wrap"><Mail size={16}/><input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@beispiel.de"/></div></label>
          {!isReset && <label className="field"><span>Passwort</span><div className="auth-input-wrap"><LockKeyhole size={16}/><input type="password" required minLength={8} autoComplete={isSignup ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Mindestens 8 Zeichen"/></div></label>}
          {isSignup && <label className="field"><span>Passwort wiederholen</span><div className="auth-input-wrap"><LockKeyhole size={16}/><input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Passwort wiederholen"/></div></label>}
          <button className="button-primary auth-submit" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16}/> : null}
            {busy ? 'Bitte warten …' : isSignup ? 'Account erstellen' : isReset ? 'Reset-Link senden' : 'Anmelden'}
          </button>
        </form>
        <div className="auth-links">
          {mode === 'login' && <><button onClick={() => {setMode('signup');setError('');setMessage('')}}>Neuen Account erstellen</button><button onClick={() => {setMode('reset');setError('');setMessage('')}}>Passwort vergessen?</button></>}
          {mode !== 'login' && <button onClick={() => {setMode('login');setError('');setMessage('')}}>Zurück zur Anmeldung</button>}
        </div>
        <div className="auth-security"><LockKeyhole size={13}/> Jeder Account kann ausschließlich seine eigenen Produkte sehen.</div>
      </section>
    </main>
  )
}


function PasswordRecoveryScreen({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < 8) {
      setError('Dein Passwort muss mindestens 8 Zeichen lang sein.')
      return
    }
    if (password !== confirmPassword) {
      setError('Die beiden Passwörter stimmen nicht überein.')
      return
    }
    setBusy(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setUpdated(true)
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand"><div className="brand-symbol">r.</div><span>resell<span className="brand-muted">manager</span></span></div>
        <div className="auth-heading">
          <div className="overline">ACCOUNT WIEDERHERSTELLEN</div>
          <h1>Neues Passwort festlegen</h1>
          <p>Wähle ein neues Passwort für deinen Reselling-Manager-Account.</p>
        </div>
        {error && <div className="auth-message error" role="alert">{error}</div>}
        {updated ? (
          <>
            <div className="auth-message success" role="status">Dein Passwort wurde erfolgreich geändert.</div>
            <button className="button-primary auth-submit" type="button" onClick={onComplete}>Zum Dashboard</button>
          </>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label className="field"><span>Neues Passwort</span><div className="auth-input-wrap"><LockKeyhole size={16}/><input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mindestens 8 Zeichen"/></div></label>
            <label className="field"><span>Passwort wiederholen</span><div className="auth-input-wrap"><LockKeyhole size={16}/><input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Passwort wiederholen"/></div></label>
            <button className="button-primary auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16}/> : null}{busy ? 'Bitte warten …' : 'Neues Passwort speichern'}</button>
          </form>
        )}
        <div className="auth-security"><LockKeyhole size={13}/> Dein neues Passwort wird sicher bei Supabase gespeichert.</div>
      </section>
    </main>
  )
}

function TrendingUpIcon() { return <ChartNoAxesCombined size={19}/> }

function Metric({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <div className="metric-card"><div className="metric-top"><span>{label}</span><div className={`metric-icon ${tone}`}>{icon}</div></div><strong className="metric-value">{value}</strong><span className="metric-detail">{detail}</span></div>
}

function EmptyState({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{text}</p>{action}</div>
}

function ProductTable({ products, onEdit, onDelete }: { products: Product[]; onEdit: (p: Product) => void; onDelete: (id: string) => void }) {
  return <div className="table-scroll"><table className="product-table"><thead><tr><th>PRODUKT</th><th>STÜCK</th><th>PLATTFORM</th><th>EINKAUF GESAMT</th><th>VERKAUF</th><th>GEWINN</th><th>STATUS</th><th/></tr></thead><tbody>{products.map(p => <tr key={p.id}><td><div className="product-name"><div className="product-thumb">{p.imageUrl ? <img src={p.imageUrl} alt={p.name}/> : <Tag size={16}/>}</div><div><strong>{p.name}</strong><span>{p.category || 'Ohne Kategorie'}{p.receiptPath ? ' · Beleg gespeichert' : ''}</span></div></div></td><td>{p.quantity || 1}</td><td>{p.platform || '–'}</td><td>{money(p.purchasePrice)}</td><td>{p.status === 'Verkauft' ? money(p.salePrice) : '–'}</td><td className={p.status === 'Verkauft' ? (profit(p) >= 0 ? 'positive' : 'negative') : 'table-muted'}>{p.status === 'Verkauft' ? money(profit(p)) : '–'}</td><td><span className={p.status === 'Verkauft' ? 'status-badge sold' : 'status-badge stock'}>{p.status}</span></td><td><div className="row-actions"><button aria-label="Bearbeiten" onClick={() => onEdit(p)}><Pencil size={15}/></button><button aria-label="Löschen" onClick={() => onDelete(p.id)}><Trash2 size={15}/></button></div></td></tr>)}</tbody></table></div>
}

function ProductModal({ product, userId, onClose, onSave }: {
  product: Product | null
  userId: string
  onClose: () => void
  onSave: (p: Product, invoiceFile?: File | null) => Promise<boolean>
}) {
  const [name, setName] = useState(product?.name || '')
  const [category, setCategory] = useState(product?.category || '')
  const [platform, setPlatform] = useState(product?.platform || '')
  const [purchasePrice, setPurchasePrice] = useState(product?.purchasePrice.toString() || '')
  const [salePrice, setSalePrice] = useState(product?.salePrice.toString() || '')
  const [shipping, setShipping] = useState(product?.shipping.toString() || '0')
  const [fees, setFees] = useState(product?.fees.toString() || '0')
  const [purchaseDate, setPurchaseDate] = useState(product?.purchaseDate || new Date().toISOString().slice(0,10))
  const [saleDate, setSaleDate] = useState(product?.saleDate || '')
  const [status, setStatus] = useState<Status>(product?.status || 'Auf Lager')
  const [quantity, setQuantity] = useState(String(product?.quantity || 1))
  const [imageUrl, setImageUrl] = useState(product?.imageUrl || '')
  const [imageAttribution, setImageAttribution] = useState(product?.imageAttribution || '')
  const [imageLicense, setImageLicense] = useState(product?.imageLicense || '')
  const [receiptPath, setReceiptPath] = useState(product?.receiptPath || '')
  const [receiptUrl, setReceiptUrl] = useState('')
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [showForm, setShowForm] = useState(Boolean(product))
  const [scanBusy, setScanBusy] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)
  const [scanStage, setScanStage] = useState('')
  const [scanError, setScanError] = useState('')
  const [ocrText, setOcrText] = useState('')
  const [imageResults, setImageResults] = useState<ProductImageResult[]>([])
  const [imageBusy, setImageBusy] = useState(false)
  const [imageError, setImageError] = useState('')
  const [saving, setSaving] = useState(false)
  const cameraInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const estimated = Number(salePrice || 0) - Number(purchasePrice || 0) - Number(shipping || 0) - Number(fees || 0)

  useEffect(() => {
    if (!receiptPath) return
    supabase.storage.from('product-invoices').createSignedUrl(receiptPath, 3600)
      .then(({ data }) => setReceiptUrl(data?.signedUrl || ''))
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
      if (!results.length) setImageError('Keine passenden frei nutzbaren Bildvorschläge gefunden. Du kannst später ein Bild ergänzen.')
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Bildsuche fehlgeschlagen.')
    } finally {
      setImageBusy(false)
    }
  }

  async function handleInvoiceFile(file?: File) {
    if (!file) return
    setInvoiceFile(file)
    setShowForm(true)
    setScanBusy(true)
    setScanError('')
    setScanProgress(0)
    setScanStage('Datei wird vorbereitet')
    try {
      const extracted = await readInvoiceFile(file, (progress, stage) => {
        setScanProgress(Math.round(progress * 100))
        setScanStage(stage)
      })
      setOcrText(extracted.text)
      if (extracted.name) setName(extracted.name)
      if (extracted.amount !== null) setPurchasePrice(extracted.amount.toFixed(2))
      if (extracted.date) setPurchaseDate(extracted.date)
      setQuantity(String(extracted.quantity || 1))
      if (extracted.name) await loadImages(extracted.name)
      else setImageError('Der Produktname war auf dem Beleg nicht eindeutig. Bitte trage ihn ein und suche dann ein Bild.')
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Der Beleg konnte nicht gelesen werden.')
    } finally {
      setScanBusy(false)
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || purchasePrice === '' || Number(quantity) < 1) return
    setSaving(true)
    void onSave({
      id: product?.id || crypto.randomUUID(),
      name: name.trim(),
      category,
      platform,
      purchasePrice: Number(purchasePrice),
      salePrice: Number(salePrice || 0),
      shipping: Number(shipping || 0),
      fees: Number(fees || 0),
      purchaseDate,
      saleDate,
      status,
      quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
      imageUrl,
      imageAttribution,
      imageLicense,
      receiptPath,
    }, invoiceFile).then(saved => {
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
      {scanBusy && <div className="scan-progress"><div className="scan-progress-top"><span><RefreshCw size={14} className="spin"/> {scanStage}</span><strong>{scanProgress}%</strong></div><div className="progress-track"><i style={{width: scanProgress + '%'}}/></div><small>Die Texterkennung läuft direkt in deinem Browser. Der Beleg wird dafür nicht an einen OCR-Dienst gesendet.</small></div>}
      {scanError && <div className="inline-error">{scanError}</div>}
    </div>
    {showForm && <form onSubmit={submit}><div className="form-grid">
      <label className="field full"><span>Produktname *</span><input autoFocus required value={name} onChange={e=>setName(e.target.value)} onBlur={() => { if (name.trim() && !imageResults.length && !imageBusy) void loadImages(name) }} placeholder="z. B. Pokémon ETB – Hidden Fates"/></label>
      <label className="field"><span>Stückzahl *</span><input required type="number" min="1" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label>
      <label className="field"><span>Kategorie</span><input value={category} onChange={e=>setCategory(e.target.value)} placeholder="z. B. Trading Cards"/></label>
      <label className="field"><span>Einkaufspreis gesamt (€) *</span><input required type="number" min="0" step="0.01" value={purchasePrice} onChange={e=>setPurchasePrice(e.target.value)} placeholder="0,00"/></label>
      <label className="field"><span>Einkaufsdatum</span><input type="date" value={purchaseDate} onChange={e=>setPurchaseDate(e.target.value)}/></label>
      <label className="field"><span>Plattform</span><select value={platform} onChange={e=>setPlatform(e.target.value)}><option value="">Bitte wählen</option><option>eBay</option><option>Kleinanzeigen</option><option>Vinted</option><option>Cardmarket</option><option>Facebook Marketplace</option><option>Sonstige</option></select></label>
      <div className="form-section full"><span>PRODUKTBILD</span></div>
      <div className="image-picker full">
        {imageUrl ? <div className="selected-image"><img src={imageUrl} alt="Vorgeschlagenes Produktbild"/><div><strong>Produktbild ausgewählt</strong><small>{imageAttribution ? 'Bildnachweis: ' + imageAttribution : 'Bildvorschlag' }{imageLicense ? ' · ' + imageLicense : ''}</small><button type="button" onClick={() => {setImageUrl('');setImageAttribution('');setImageLicense('')}}>Entfernen</button></div></div> : <div className="image-empty"><ImagePlus size={18}/><span>Nach dem Einlesen wird automatisch nach einem passenden Bild gesucht.</span></div>}
        <div className="image-search-row"><button type="button" className="button-secondary" disabled={!name.trim() || imageBusy} onClick={() => void loadImages(name, false)}>{imageBusy ? <RefreshCw size={14} className="spin"/> : <Search size={14}/>} {imageBusy ? 'Suche läuft …' : 'Bild suchen'}</button>{imageError && <small>{imageError}</small>}</div>
        {imageResults.length > 0 && <div className="image-suggestions">{imageResults.map(item => <button type="button" key={item.id} className={imageUrl === item.url ? 'image-choice-thumb chosen' : 'image-choice-thumb'} onClick={() => {setImageUrl(item.url);setImageAttribution(item.creator);setImageLicense(item.license)}}><img src={item.thumbnail} alt={item.title}/><span>{item.creator || item.title}</span></button>)}</div>}
      </div>
      <div className="form-section full"><span>VERKAUF & KOSTEN</span></div>
      <label className="field"><span>Verkaufspreis gesamt (€)</span><input type="number" min="0" step="0.01" value={salePrice} onChange={e=>setSalePrice(e.target.value)} placeholder="0,00"/></label>
      <label className="field"><span>Versandkosten (€)</span><input type="number" min="0" step="0.01" value={shipping} onChange={e=>setShipping(e.target.value)}/></label>
      <label className="field"><span>Plattformgebühren (€)</span><input type="number" min="0" step="0.01" value={fees} onChange={e=>setFees(e.target.value)}/></label>
      <label className="field"><span>Verkaufsdatum</span><input type="date" value={saleDate} onChange={e=>setSaleDate(e.target.value)}/></label>
      <label className="field"><span>Status</span><select value={status} onChange={e=>setStatus(e.target.value as Status)}><option>Auf Lager</option><option>Verkauft</option></select></label>
      {ocrText && <details className="ocr-details full"><summary>Erkannten Rechnungstext anzeigen</summary><pre>{ocrText.slice(0, 8000)}</pre></details>}
      <div className="profit-preview full"><div><span>Voraussichtlicher Gewinn</span><small>Verkauf gesamt − Einkauf gesamt − Versand − Gebühren</small></div><strong className={estimated >= 0 ? 'positive' : 'negative'}>{money(estimated)}</strong></div>
    </div><div className="modal-actions"><button type="button" className="button-ghost" onClick={onClose} disabled={saving}>Abbrechen</button><button type="submit" className="button-primary" disabled={saving || scanBusy}>{saving ? <LoaderCircle size={15} className="spin"/> : null}{saving ? 'Speichert …' : product ? 'Änderungen speichern' : 'Produkt speichern'}</button></div></form>}
  </div></div>
}

function HelpModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop help-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="modal-card help-card">
    <div className="modal-header"><div><span className="overline">RESSELLMANAGER GUIDE</span><h2>Wie können wir helfen?</h2><p>Die wichtigsten Funktionen auf einen Blick.</p></div><button className="modal-close" onClick={onClose}><X size={19}/></button></div>
    <div className="help-content">
      <div className="help-item"><span><FileUp size={18}/></span><div><strong>Produkt aus Rechnung erstellen</strong><p>Beim Hinzufügen kannst du einen Beleg mit der Kamera aufnehmen oder als PDF/Bild hochladen. Text, Name, Preis und Datum werden automatisch erkannt, soweit sie lesbar sind.</p></div></div>
      <div className="help-item"><span><ImagePlus size={18}/></span><div><strong>Produktbilder</strong><p>Die App sucht nach frei kommerziell nutzbaren Bildvorschlägen. Prüfe bitte, ob das Motiv wirklich zu deinem Produkt passt.</p></div></div>
      <div className="help-item"><span><Moon size={18}/></span><div><strong>Dark Mode</strong><p>Über das Mond-/Sonnensymbol oben kannst du jederzeit zwischen dunklem und hellem Erscheinungsbild wechseln.</p></div></div>
      <div className="help-item"><span><LockKeyhole size={18}/></span><div><strong>Private Daten</strong><p>Produkte und Belege sind deinem Account zugeordnet. Die OCR-Texterkennung läuft im Browser; der Originalbeleg wird erst beim Speichern in deinem privaten Cloud-Speicher abgelegt.</p></div></div>
    </div>
    <div className="modal-actions"><button className="button-primary" onClick={onClose}>Alles klar</button></div>
  </section></div>
}

export default App