import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { getStaffSession } from '@/lib/session';

/**
 * Admin route guard.
 *
 * The original asked for a name + PIN via the `employee-auth` edge function —
 * a second login after the main one, which was also the hole that let any
 * employee reach admin screens by supplying an admin's name and PIN.
 *
 * With Neon Auth, admin-ness is already established once, at sign-in: the main
 * login refuses to issue an admin session to a non-admin, and the permission
 * list is resolved from the database by the same function RLS uses. So this
 * guard trusts that verified session. When no admin session is present it
 * re-verifies the current user's password rather than asking for a name + PIN
 * that someone else could type.
 */

interface AdminLoginGateProps {
  children: React.ReactNode;
}

const SESSION_KEY = 'admin_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 hours
const AUTH_BASE = import.meta.env.VITE_NEON_AUTH_URL as string;

const AdminLoginGate = ({ children }: AdminLoginGateProps) => {
  const [authenticated, setAuthenticated] = useState(false);
  const [adminName, setAdminName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    try {
      // Dedicated admin session for this tab
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        const session = JSON.parse(stored);
        if (session.expiresAt > Date.now()) {
          setAuthenticated(true);
          setAdminName(session.name);
          setChecking(false);
          return;
        }
        sessionStorage.removeItem(SESSION_KEY);
      }
      // The staff session was only issued as admin if the database said so.
      const staffSession = getStaffSession();
      if (staffSession?.isAdmin && staffSession.token) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
          name: staffSession.name,
          employeeId: staffSession.employeeId,
          expiresAt: Math.min(staffSession.expiresAt, Date.now() + SESSION_DURATION),
        }));
        setAuthenticated(true);
        setAdminName(staffSession.name);
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
    setChecking(false);
  }, []);

  const handleLogin = async () => {
    if (!password) return;

    const staff = getStaffSession();
    const email = (staff as unknown as { email?: string } | null)?.email;
    if (!email) {
      toast.error('No signed-in account. Please sign in from the home screen.');
      return;
    }
    if (!AUTH_BASE) {
      toast.error('VITE_NEON_AUTH_URL is not configured');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${AUTH_BASE}/sign-in/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(typeof window !== 'undefined' ? { Origin: window.location.origin } : {}),
        },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        toast.error('Incorrect password');
        return;
      }

      const name = staff?.name || email;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        name,
        employeeId: staff?.employeeId ?? '',
        expiresAt: Date.now() + SESSION_DURATION,
      }));
      setAuthenticated(true);
      setAdminName(name);
      setPassword('');
      toast.success(`Welcome, ${name}`);
    } catch {
      toast.error('Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setAuthenticated(false);
    setAdminName('');
    setPassword('');
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-navy-texture flex items-center justify-center">
        <p className="font-body text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!authenticated) {
    const staff = getStaffSession();
    const email = (staff as unknown as { email?: string } | null)?.email;

    return (
      <div className="min-h-screen bg-navy-texture flex items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <Lock className="w-8 h-8 text-primary" />
            </div>
            <h1 className="font-display text-xl tracking-wider text-foreground">Admin Access</h1>
            <p className="font-body text-sm text-muted-foreground">
              {email
                ? `Confirm your password to continue`
                : 'Sign in from the home screen to continue'}
            </p>
            {email && (
              <p className="font-body text-xs text-muted-foreground">{email}</p>
            )}
          </div>
          {email && (
            <div className="space-y-3">
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                className="bg-secondary border-border text-foreground font-body text-center text-lg h-12"
                onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }}
                autoFocus
              />
              <Button
                onClick={handleLogin}
                disabled={loading || !password}
                className="w-full font-display text-sm tracking-wider h-12"
              >
                {loading ? 'Verifying...' : 'Sign In'}
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={handleLogout}
        className="fixed top-4 right-4 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/80 backdrop-blur border border-border text-muted-foreground hover:text-foreground transition-colors"
        title={`Logged in as ${adminName}`}
      >
        <span className="font-body text-xs hidden sm:inline">{adminName}</span>
        <LogOut className="w-3.5 h-3.5" />
      </button>
      {children}
    </div>
  );
};

export default AdminLoginGate;
