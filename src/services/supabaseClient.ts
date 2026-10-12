import { createClient } from '@supabase/supabase-js';

const runtime = typeof window !== 'undefined' ? (window as any).__SCOUT_CONFIG__ : null;
const url = (import.meta as any).env?.VITE_SUPABASE_URL || runtime?.supabaseUrl;
const key = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || runtime?.supabasePublishableKey;

export const supabase = url && key ? createClient(url, key) : null;

export function getSupabaseInfo() {
	return {
		url: url || null,
		hasKey: !!key,
		clientPresent: !!supabase,
	};
}

export default supabase;
