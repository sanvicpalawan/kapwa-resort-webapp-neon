const SESSION_KEY = 'staff_home_session';
const REMEMBER_FLAG = 'staff_remember';
const SHORT_DURATION = 8 * 60 * 60 * 1000; // 8 hours
const LONG_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface StaffSession {
  name: string;
  employeeId: string;
  isAdmin?: boolean;
  permissions: string[];
  /** Neon Auth account email. Used for step-up re-authentication, which must
   *  re-verify THIS user rather than accept an arbitrary name + PIN. */
  email?: string;
  /** Neon Auth EdDSA JWT, accepted by the Neon Data API on every request.
   *  Absent when sign-in failed to mint one; such a session cannot read data. */
  token?: string;
  expiresAt: number;
}

/**
 * Read a JWT's `exp` without verifying it.
 *
 * The minted token lives 15 minutes while the session itself survives days, so
 * `expiresAt` above says nothing about whether `token` still works. Decoding
 * `exp` lets a caller re-mint *before* a request is sent instead of discovering
 * the staleness afterwards as an unexplained 401.
 */
export const staffTokenExpiry = (token?: string): number | null => {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    const claims = JSON.parse(atob(padded));
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
};

/** True when the stored JWT is absent or inside `skewMs` of expiring. */
export const isStaffTokenExpired = (skewMs = 30_000): boolean => {
  const exp = staffTokenExpiry(getStaffSession()?.token);
  return exp === null || exp - skewMs <= Date.now();
};

/** Replace only the JWT in the stored session, preserving its 8h/7d lifetime. */
export const setStaffToken = (token: string) => {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(SESSION_KEY);
      if (!raw) continue;
      const session: StaffSession = JSON.parse(raw);
      if (!session.expiresAt || session.expiresAt <= Date.now()) continue;
      store.setItem(SESSION_KEY, JSON.stringify({ ...session, token }));
    } catch {
      // A corrupt entry is dropped by getStaffSession on its next read.
    }
  }
};

/** Read the staff session from localStorage (remembered) or sessionStorage */
export const getStaffSession = (): StaffSession | null => {
  try {
    // Check remembered (localStorage) first
    const remembered = localStorage.getItem(SESSION_KEY);
    if (remembered) {
      const s: StaffSession = JSON.parse(remembered);
      if (s.expiresAt > Date.now()) return s;
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(REMEMBER_FLAG);
    }
    // Fall back to session-only
    const temp = sessionStorage.getItem(SESSION_KEY);
    if (temp) {
      const s: StaffSession = JSON.parse(temp);
      if (s.expiresAt > Date.now()) return s;
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  }
  return null;
};

/** Save the staff session. If `remember` is true, persist in localStorage with 7-day expiry. */
export const setStaffSession = (session: Omit<StaffSession, 'expiresAt'>, remember: boolean) => {
  const duration = remember ? LONG_DURATION : SHORT_DURATION;
  const full: StaffSession = { ...session, expiresAt: Date.now() + duration };

  if (remember) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(full));
    localStorage.setItem(REMEMBER_FLAG, '1');
    // Also set in sessionStorage so same-tab reads work uniformly
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(full));
  } else {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(full));
    // Clean up any old remembered session
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(REMEMBER_FLAG);
  }
};

/** Clear the staff session from both storages */
export const clearStaffSession = () => {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(REMEMBER_FLAG);
  localStorage.removeItem('emp_id');
  localStorage.removeItem('emp_name');
};

/** Check if "remember me" was previously selected */
export const isRemembered = (): boolean => {
  return localStorage.getItem(REMEMBER_FLAG) === '1';
};

/** The current staff JWT, if one was issued at login. Used by the Supabase client
 *  to authenticate requests once RLS enforces claim-based access. */
export const getStaffToken = (): string | null => {
  return getStaffSession()?.token ?? null;
};
