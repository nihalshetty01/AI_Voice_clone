import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL in env variables.');
}

// Initialize Supabase client. Since we are doing DB operations solely on the Next.js API routes (backend),
// we use the SUPABASE_SERVICE_ROLE_KEY to bypass Row Level Security (RLS) safely.
export const supabase = createClient(
  supabaseUrl,
  supabaseServiceKey || supabaseAnonKey || ''
);
