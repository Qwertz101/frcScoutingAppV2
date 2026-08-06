import React, { useState, useEffect } from 'react';
import { User } from '../types';
import { BoltMark } from './cc/CCChrome';
import { DataService } from '../services/dataService';
import supabase from '../services/supabaseClient';
import { performHardRefresh, performFullRefresh } from '../services/syncService';

interface LoginPageProps {
  onLogin: (user: User) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [alliance, _setAlliance] = useState<'red' | 'blue'>('red');
  const [position, _setPosition] = useState<1 | 2 | 3>(1);
  const [loadingLogin, setLoadingLogin] = useState(false);

  const [showInvalid, setShowInvalid] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Auto-refresh once per client install/session: perform a full refresh
  // on first visit to the login page so the app loads the latest server state.
  useEffect(() => {
    try {
      const flag = localStorage.getItem('frc-auto-refreshed-v1');
      if (!flag) {
        // Mark before performing refresh to avoid reload loops
        localStorage.setItem('frc-auto-refreshed-v1', Date.now().toString());
        setLoadingLogin(true);
        performFullRefresh({ reload: true }).catch((e) => {
          // do not block the UI if refresh fails
          // eslint-disable-next-line no-console
          console.warn('Login auto-refresh failed', e);
          setLoadingLogin(false);
        });
      }
    } catch (e) {
      // ignore environments without localStorage
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setLoadingLogin(true);

    const name = username.trim();
    const isAdmin = name.toLowerCase() === 'admin6560';

    if (isAdmin) {
      // simple admin password check against Supabase 'admins' table (insecure by design)
      try {
        // Quick local override: if the developer wants to force the local dev password to work
        // even when Supabase is configured, accept it here. This is intentionally insecure
        // and only intended as a short-term hotfix — prefer updating the admin password
        // in the Supabase `admins` table instead.
        if (password === 'charge') {
          onLogin({ username: name, alliance, position, isAdmin: true });
          return;
        }
        if (!supabase) {
          // Supabase isn't configured (often happens in development). Fall back to the local dev admin password.
          // This is intentionally insecure and only for convenience/testing.
          // eslint-disable-next-line no-console
          console.warn('Supabase client not configured; falling back to local admin password check');
          if (password === 'charge') {
            onLogin({ username: name, alliance, position, isAdmin: true });
            return;
          }
          setErrorMessage('Incorrect admin password.');
          setShowInvalid(true);
          setLoadingLogin(false);
          return;
        }

        // If Supabase is configured, try DB-backed admin check first
        const { data, error } = await supabase.from('admins').select('password').eq('username', name).limit(1).single();
        if (error) {
          // If there's a DB error, log it and fallback to the plaintext 'charge' password for convenience
          // eslint-disable-next-line no-console
          console.error('Supabase admin lookup error, falling back to local password check', error);
          if (password === 'charge') {
            onLogin({ username: name, alliance, position, isAdmin: true });
            return;
          }
          setErrorMessage('Admin login failed: admin record not found or DB error. See console for details.');
          setShowInvalid(true);
          setLoadingLogin(false);
          return;
        }

        if (!data) {
          setErrorMessage('Admin login failed: admin record not found.');
          // eslint-disable-next-line no-console
          console.warn('Supabase admin lookup returned no rows');
          setShowInvalid(true);
          setLoadingLogin(false);
          return;
        }

        if (data.password !== password) {
          setErrorMessage('Incorrect admin password.');
          setShowInvalid(true);
          setLoadingLogin(false);
          return;
        }

        onLogin({ username: name, alliance, position, isAdmin: true });
        return;
      } catch (e) {
        setErrorMessage('Admin login error (see console for details).');
        // eslint-disable-next-line no-console
        console.error('Admin login exception', e);
        setShowInvalid(true);
        setLoadingLogin(false);
        return;
      }
    }

    // Validate against scouters added by admin (case-insensitive match on scouter.name)
    const scouters = DataService.getScouters();
    const matched = scouters.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!matched) {
      setErrorMessage('The username you entered is not a registered scouter. Please check with your admin.');
      setShowInvalid(true);
      setLoadingLogin(false);
      return;
    }
    try {
      // Attempt a non-destructive sync before completing login so the scouter
      // sees authoritative DB state (push pending rows, pull server rows).
      await performFullRefresh({ reload: false });
    } catch (e) {
      // do not block login if refresh fails; proceed and warn in console
      // eslint-disable-next-line no-console
      console.warn('Login: performFullRefresh failed', e);
    }

    onLogin({
      username: matched.name,
      alliance: matched.alliance,
      position: matched.position,
      isAdmin: false,
    });
  };

  const isAdminName = username.toLowerCase() === 'admin6560';

  return (
    <div className="cc-root cc-login">
      <div className="cc-login-inner">
        <div className="cc-login-brand">
          <BoltMark />
          <div className="cc-login-wordmark">
            <h1>SCOUT 6560</h1>
            <span>Competition Scouting System</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="cc-login-card">
          <label className="cc-field">
            <span className="cc-login-label">Username</span>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="cc-input"
              disabled={loadingLogin}
              placeholder="Enter your username"
              required
            />
          </label>

          {isAdminName && (
            <label className="cc-field">
              <span className="cc-login-label">Password</span>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="cc-input"
                disabled={loadingLogin}
                placeholder="Admin password"
                required
              />
            </label>
          )}

          <button type="submit" disabled={loadingLogin} className="cc-login-submit">
            {loadingLogin ? (
              <>
                <span className="cc-spinner" />
                Logging in…
              </>
            ) : isAdminName ? (
              'Admin Login'
            ) : (
              'Start Scouting'
            )}
          </button>

          <div className="cc-login-rule" />

          <ForceRefreshControl />
        </form>

        <p className="cc-login-foot">FRC Team 6560 · Charging Champions</p>
      </div>

      {showInvalid && (
        <div className="cc-modal-backdrop">
          <div className="cc-modal">
            <h3>LOGIN ERROR</h3>
            <p>
              {errorMessage ||
                'The username you entered is not a registered scouter. Please check with your admin.'}
            </p>
            <div className="cc-modal-actions">
              <button
                className="cc-btn-primary"
                onClick={() => {
                  setShowInvalid(false);
                  setErrorMessage('');
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ForceRefreshControl() {
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);

  // Hard-refresh is now the only supported refresh: perform a full clear of
  // local site data and reload so the client boots fresh from server state.

  return (
    <>
      <button type="button" onClick={() => setShowConfirm(true)} className="cc-login-secondary">
        Force refresh · clear caches
      </button>

      {showConfirm && (
        <div className="cc-modal-backdrop">
          <div className="cc-modal">
            <h3>FORCE REFRESH</h3>
            <p>
              This will unregister service workers and clear cached assets so the app loads the
              latest code.
            </p>
            <p>
              The app will automatically backup and clean local data: valid rows are preserved,
              malformed entries are removed.
            </p>
            {statusMessage && <div className="cc-banner info">{statusMessage}</div>}
            <div className="cc-modal-actions">
              <button type="button" onClick={() => setShowConfirm(false)} className="cc-btn-outline">
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    setWorking(true);
                    setStatusMessage('Performing hard refresh...');
                    await performHardRefresh();
                  } catch (e) {
                    // eslint-disable-next-line no-console
                    console.error('Hard refresh failed', e);
                    alert('Hard refresh failed - see console for details');
                  } finally {
                    setWorking(false);
                    setShowConfirm(false);
                  }
                }}
                disabled={working}
                className="cc-btn-danger"
              >
                {working ? 'Working…' : 'Hard refresh'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}