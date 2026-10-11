import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useResortProfile } from '@/hooks/useResortProfile';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DoorOpen, Users, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { getStaffSession, setStaffSession, isRemembered } from '@/lib/session';
import { neonSignIn, neonSignOut } from '@/lib/neonAuth';
import { getHomeRoute } from '@/lib/getHomeRoute';
import ThemeToggle from '@/components/ThemeToggle';

/**
 * Login is Neon Auth (email + password) rather than the original name + PIN
 * against the `employee-auth` edge function. The resolved Neon Auth JWT lands
 * in the session's `token` slot, which is exactly what the Data API requires on
 * every request, so no probe of PostgREST acceptance is needed here — a bad
 * token fails loudly at the request rather than silently degrading.
 */

const Index = () => {
  const navigate = useNavigate();
  const { data: profile } = useResortProfile();
  const logoSize = profile?.logo_size || 128;

  const [mode, setMode] = useState<null | 'staff' | 'admin'>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => isRemembered());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const existing = getStaffSession();
    // A session without a JWT cannot reach the Data API, which rejects
    // anonymous requests outright. Treat it as signed out.
    if (!existing?.token) return;
    navigate(getHomeRoute(existing.permissions), { replace: true });
  }, [navigate]);



  const handleLogin = async () => {
    if (!email.trim() || !password) return;
    setLoading(true);

    try {
      const result = await neonSignIn(email.trim().toLowerCase(), password);

      if (!result.ok) {
        toast.error(result.error || 'Login failed');
        return;
      }

      const permissions = result.permissions ?? [];
      const isAdmin = result.isAdmin ?? permissions.includes('admin');

      if (mode === 'admin' && !isAdmin) {
        toast.error('Admin access required');
        return;
      }

      // The Neon Auth JWT is the credential every Data API request carries, so
      // a session without one cannot read anything and is not worth keeping.
      if (!result.token) {
        toast.error('Sign-in succeeded but no session token was issued.');
        return;
      }

      setStaffSession(
        {
          name: result.name || email,
          employeeId: result.employeeId ?? '',
          isAdmin,
          permissions,
          email: result.email,
          token: result.token,
        },
        remember,
      );

      if (result.employeeId) localStorage.setItem('emp_id', result.employeeId);
      localStorage.setItem('emp_name', result.name || email);
      toast.success(`Welcome, ${result.name || email}`);
      navigate(getHomeRoute(permissions));
    } catch {
      toast.error('Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden flex flex-col items-center justify-center px-6 py-10 bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(ellipse 90% 60% at 50% -10%, hsl(var(--gold) / 0.18), transparent 60%),' +
            'radial-gradient(ellipse 70% 60% at 80% 110%, hsl(var(--teal) / 0.18), transparent 60%),' +
            'radial-gradient(ellipse 60% 50% at 0% 60%, hsl(var(--emerald) / 0.10), transparent 70%),' +
            'linear-gradient(180deg, hsl(var(--background)) 0%, hsl(var(--navy-deep)) 100%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.04]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 30%, white 1px, transparent 1px), radial-gradient(circle at 70% 80%, white 1px, transparent 1px), radial-gradient(circle at 40% 70%, white 1px, transparent 1px)',
          backgroundSize: '180px 180px, 240px 240px, 300px 300px',
        }}
      />

      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      {profile?.logo_url && (
        <div className="mb-6 animate-fade-in" style={{ width: logoSize, height: logoSize }}>
          <img
            src={profile.logo_url}
            alt={profile.resort_name || 'Resort logo'}
            className="w-full h-full object-contain drop-shadow-[0_0_24px_hsl(var(--gold)/0.25)]"
          />
        </div>
      )}

      {profile?.resort_name && (
        <h1 className="font-serif-display text-5xl md:text-6xl tracking-[0.18em] text-foreground text-center mb-3 animate-fade-in">
          {profile.resort_name}
        </h1>
      )}

      {profile?.tagline && (
        <p className="font-body text-xs uppercase tracking-[0.4em] text-gold/80 mb-2">
          {profile.tagline}
        </p>
      )}
      <div className="mb-10" />

      {!mode ? (
        <div className="flex flex-col gap-3 w-full max-w-sm animate-fade-in">
          <p className="font-serif-display italic text-2xl text-foreground text-center mb-1">Welcome</p>
          <p className="font-body text-xs text-muted-foreground tracking-wider text-center mb-4">
            Please select how you'd like to continue
          </p>

          <button
            onClick={() => navigate('/guest-portal')}
            className="group relative flex items-center gap-4 luxury-glass rounded-2xl px-5 py-5 text-left hover:border-gold/40 transition-all duration-300 hover:translate-y-[-1px]"
          >
            <span className="inline-flex w-12 h-12 items-center justify-center rounded-xl bg-gold/10 border border-gold/30 text-gold group-hover:bg-gold/15 transition-colors">
              <DoorOpen className="w-5 h-5" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-serif-display text-xl text-foreground">I'm a Guest</span>
              <span className="block font-body text-xs text-muted-foreground mt-0.5">Explore our resort</span>
            </span>
            <span className="text-gold/60 group-hover:text-gold transition-colors">›</span>
          </button>

          <button
            onClick={() => setMode('staff')}
            className="group relative flex items-center gap-4 luxury-glass rounded-2xl px-5 py-5 text-left hover:border-gold/40 transition-all duration-300 hover:translate-y-[-1px]"
          >
            <span className="inline-flex w-12 h-12 items-center justify-center rounded-xl bg-teal/10 border border-teal/30 text-teal group-hover:bg-teal/15 transition-colors">
              <Users className="w-5 h-5" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-serif-display text-xl text-foreground">Staff</span>
              <span className="block font-body text-xs text-muted-foreground mt-0.5">Access staff systems</span>
            </span>
            <span className="text-gold/60 group-hover:text-gold transition-colors">›</span>
          </button>

          <button
            onClick={() => setMode('admin')}
            className="group relative flex items-center gap-4 luxury-glass rounded-2xl px-5 py-5 text-left hover:border-gold/40 transition-all duration-300 hover:translate-y-[-1px]"
          >
            <span className="inline-flex w-12 h-12 items-center justify-center rounded-xl bg-emerald/10 border border-emerald/30 text-emerald group-hover:bg-emerald/15 transition-colors">
              <Shield className="w-5 h-5" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-serif-display text-xl text-foreground">Admin</span>
              <span className="block font-body text-xs text-muted-foreground mt-0.5">Administrative access</span>
            </span>
            <span className="text-gold/60 group-hover:text-gold transition-colors">›</span>
          </button>

          <div className="mt-2 rounded-2xl border border-dashed border-gold/30 p-3">
            <p className="font-body text-[10px] uppercase tracking-[0.3em] text-muted-foreground text-center mb-2">
              Guest access
            </p>
            <Button variant="secondary" className="w-full font-body text-xs" onClick={() => navigate('/guest-portal')}>
              Enter Guest Portal
            </Button>
          </div>


          <p className="font-body text-[10px] tracking-[0.35em] uppercase text-gold/70 text-center mt-6">
            {profile?.resort_name ? `${profile.resort_name.split(' ')[0]} · Where Nature Welcomes You Home` : 'Where Nature Welcomes You Home'}
          </p>
        </div>
      ) : (
        <div className="w-full max-w-xs space-y-3">
          <p className="font-display text-sm tracking-wider text-foreground text-center mb-2">
            {mode === 'admin' ? 'Admin Login' : 'Staff Login'}
          </p>
          <Input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            className="bg-secondary border-border text-foreground font-body text-center text-lg h-12"
            onKeyDown={e => { if (e.key === 'Enter') document.getElementById('home-password')?.focus(); }}
            autoFocus
          />
          <Input
            id="home-password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="bg-secondary border-border text-foreground font-body text-center text-lg h-12"
            onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }}
          />
          <div className="flex items-center gap-2 px-1">
            <Checkbox
              id="remember-me"
              checked={remember}
              onCheckedChange={(v) => setRemember(v === true)}
            />
            <label htmlFor="remember-me" className="font-body text-sm text-muted-foreground cursor-pointer select-none">
              Remember me on this device
            </label>
          </div>
          <Button
            onClick={handleLogin}
            disabled={loading || !email.trim() || !password}
            className="w-full font-display text-sm tracking-wider h-12"
          >
            {loading ? 'Verifying...' : 'Sign In'}
          </Button>
          <button
            onClick={() => { setMode(null); setEmail(''); setPassword(''); }}
            className="w-full font-body text-xs text-muted-foreground hover:text-foreground py-2 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

export default Index;
