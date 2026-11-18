import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

test('Google login is wired to Supabase OAuth and has a visible sign-in action', () => {
  const authScreen = read('src/components/AuthScreen.tsx')
  const app = read('src/App.tsx')
  const client = read('src/lib/supabase.ts')

  assert.match(authScreen, /Mit Google anmelden/)
  assert.match(app, /signInWithOAuth\(\s*\{\s*provider:\s*'google'/s)
  assert.match(app, /redirectTo:\s*window\.location\.origin/)
  assert.match(client, /flowType:\s*'pkce'/)
  assert.match(client, /persistSession:\s*true/)
  assert.match(client, /autoRefreshToken:\s*true/)
  assert.match(client, /detectSessionInUrl:\s*true/)
})

test('the browser client uses a publishable key and does not contain a service-role secret', () => {
  const client = read('src/lib/supabase.ts')

  assert.match(client, /sb_publishable_/)
  assert.doesNotMatch(client, /service_role|SUPABASE_SERVICE_ROLE_KEY|sb_secret_/i)
})

test('products and account settings have user-owned RLS policies', () => {
  const productsMigration = read('supabase/migrations/20261117144833_create_user_owned_products.sql')
  const settingsMigration = read('supabase/migrations/20261118110505_add_cloud_sync_and_user_settings.sql')

  assert.match(productsMigration, /alter table public\.products enable row level security/i)
  assert.match(productsMigration, /auth\.uid\(\)/)
  assert.match(settingsMigration, /alter table public\.user_settings enable row level security/i)
  assert.match(settingsMigration, /auth\.uid\(\)/)
  assert.match(settingsMigration, /with check\s*\(\(select auth\.uid\(\)\) = user_id\)/i)
})

test('receipt storage is private and paths are scoped to the signed-in user', () => {
  const migration = read('supabase/migrations/20261117144833_create_user_owned_products.sql')
  const client = read('src/lib/supabase.ts')

  assert.match(migration, /'product-invoices',[\s\S]*?false,/)
  assert.match(migration, /storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/)
  assert.match(client, /const RECEIPT_BUCKET = 'product-invoices'/)
  assert.match(client, /MAX_RECEIPT_BYTES = 10 \* 1024 \* 1024/)
})

test('product changes are synchronized and refreshed through Supabase Realtime', () => {
  const app = read('src/App.tsx')

  assert.match(app, /supabase\.channel\('reselling-products-' \+ userId\)/)
  assert.match(app, /postgres_changes/)
  assert.match(app, /from\('products'\)\.upsert/)
  assert.match(app, /from\('products'\)\.update\(\{ deleted_at:/)
})

test('Cloudflare Previews declare the AI binding that production uses', () => {
  const config = JSON.parse(read('wrangler.jsonc'))

  assert.equal(config.ai?.binding, 'AI')
  assert.equal(config.previews?.ai?.binding, 'AI')
})

test('Google OAuth setup documents the stable Preview origin and allow-list entry', () => {
  const docs = read('docs/GOOGLE_AUTH_SETUP.md')

  assert.match(docs, /https:\/\/feature-google-auth-cloud-sync-reselling-manager\.j6c2njff5r\.workers\.dev/)
  assert.match(docs, /Additional Redirect URLs/)
})


test('settings are grouped, Gmail is collapsible and sign-out is the last account action', () => {
  const app = read('src/App.tsx')
  const settingsStart = app.indexOf("settings-group")
  const signOut = app.indexOf("settings-signout-row")
  const footer = app.indexOf("page-footer")
  assert.ok(settingsStart >= 0 && signOut > settingsStart && footer > signOut)
  assert.match(app, /<details className="gmail-panel">/)
  assert.match(app, /Version \{APP_VERSION\}/)
})

test('sync status is truthful, accessible and respects reduced-motion preferences', () => {
  const app = read('src/App.tsx')
  const css = read('src/index.css')
  assert.match(app, /sync-\$\{cloudSyncState\}/)
  assert.match(app, /aria-live="polite"/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
})

test('backup restore accepts all currencies supported by the account settings', () => {
  const app = read('src/App.tsx')
  assert.match(app, /isSupportedCurrency\(restoredCurrency\)/)
})
