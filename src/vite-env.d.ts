/// <reference types="vite/client" />

interface Window {
  __SCOUT_CONFIG__?: {
    supabaseUrl?: string;
    supabasePublishableKey?: string;
  };
}
