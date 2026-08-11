import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL  as string
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string

// vite-react-ssg's build imports every route (including auth/dashboard) to
// construct the route tree, even though only "/" is ever rendered on the
// server — so this module always loads under Node during that pass.
// supabase-js's RealtimeClient constructor throws there without a global
// WebSocket (stable only since Node 22; CI runs Node 20). None of this
// client's consumers render during the server pass (only Landing does, and
// it doesn't touch auth), so deferring construction to the browser is safe.
export const supabase = (
  typeof window === 'undefined' ? null : createClient(supabaseUrl, supabaseAnon)
) as SupabaseClient
