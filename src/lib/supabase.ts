import { createClient } from '@supabase/supabase-js'

// These are public client settings. Row Level Security protects every user's rows.
// Never put a Supabase secret/service-role key in this browser app.
const supabaseUrl = 'https://uuvffkcxgxarfaecwjiz.supabase.co'
const supabasePublishableKey = 'sb_publishable_TDlHIq5LhZsmhHQbu-PQpQ_Q41qhAmL'

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
