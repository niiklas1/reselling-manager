import { createClient } from '@supabase/supabase-js'

// These are public browser credentials. Row Level Security and Storage policies,
// not secrecy of the publishable key, protect each user's data.
const SUPABASE_URL = 'https://uuvffkcxgxarfaecwjiz.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_TDlHIq5LhZsmhHQbu-PQpQ_Q41qhAmL'

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'reselling-manager-auth',
  },
})

export const CLOUD_RECEIPT_PREFIX = 'cloud:'
const RECEIPT_BUCKET = 'product-invoices'
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024
const ALLOWED_RECEIPT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
])

function safeFileName(value: string): string {
  const cleaned = value.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-90)
  return cleaned || 'beleg'
}

export async function uploadCloudReceipt(userId: string, file: File): Promise<string> {
  if (file.size > MAX_RECEIPT_BYTES) {
    throw new Error('Der Beleg ist größer als 10 MB. Bitte verkleinere die Datei und versuche es erneut.')
  }
  if (!ALLOWED_RECEIPT_TYPES.has(file.type)) {
    throw new Error('Dieses Dateiformat wird für Belege nicht unterstützt. Erlaubt sind PDF, JPG, PNG, WebP und HEIC.')
  }
  const path = userId + '/' + crypto.randomUUID() + '-' + safeFileName(file.name)
  const { error } = await supabase.storage.from(RECEIPT_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type,
    upsert: false,
  })
  if (error) throw new Error('Der Beleg konnte nicht in der Cloud gespeichert werden: ' + error.message)
  return CLOUD_RECEIPT_PREFIX + path
}

export async function downloadCloudReceipt(path: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).download(path)
  if (error) throw new Error('Der Cloud-Beleg konnte nicht geladen werden: ' + error.message)
  return data
}

export async function deleteCloudReceipt(path: string): Promise<void> {
  const { error } = await supabase.storage.from(RECEIPT_BUCKET).remove([path])
  if (error) throw new Error('Der Cloud-Beleg konnte nicht gelöscht werden: ' + error.message)
}
