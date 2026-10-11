import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { getStaffSession } from '@/lib/session';

/**
 * Step-up re-authentication for sensitive actions.
 *
 * The original asked for any employee's name + PIN via the `employee-auth`
 * edge function, which let one staff member confirm another's action. Neon Auth
 * signs in per-user with email + password and issues no PIN, so this now
 * re-verifies the *currently signed-in* user's password — the same gate, scoped
 * to the session that is actually open.
 *
 * The confirmed identity therefore always comes from the session, never from
 * whatever the dialog collected.
 */

interface PasswordConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (employee: { id: string; name: string; display_name: string }) => void;
  title?: string;
  description?: string;
}

const AUTH_BASE = import.meta.env.VITE_NEON_AUTH_URL as string;

const PasswordConfirmModal = ({
  open,
  onClose,
  onConfirm,
  title = 'Confirm your password',
  description = 'Re-enter your password to confirm this action.',
}: PasswordConfirmModalProps) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const session = getStaffSession();

  const handleVerify = async () => {
    if (!password) return;

    const email = (session as unknown as { email?: string } | null)?.email;
    if (!email) {
      toast.error('No signed-in account on this session. Please sign in again.');
      onClose();
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

      // Identity comes from the session, not the dialog.
      onConfirm({
        id: session?.employeeId ?? '',
        name: session?.name ?? email,
        display_name: session?.name ?? email,
      });
      setPassword('');
    } catch {
      toast.error('Verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={v => { if (!v) { onClose(); setPassword(''); } }}
    >
      <DialogContent className="bg-card border-border max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display tracking-wider flex items-center gap-2">
            <Lock className="w-4 h-4" /> {title}
          </DialogTitle>
          <DialogDescription className="font-body text-xs text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {session?.name && (
            <p className="font-body text-xs text-muted-foreground text-center">
              Confirming as <span className="text-foreground">{session.name}</span>
            </p>
          )}
          <Input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="bg-secondary border-border text-foreground font-body text-center text-lg h-12"
            onKeyDown={e => { if (e.key === 'Enter') handleVerify(); }}
            autoFocus
          />
          <Button
            onClick={handleVerify}
            disabled={loading || !password}
            className="w-full font-display tracking-wider min-h-[44px]"
          >
            {loading ? 'Verifying...' : 'Confirm'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PasswordConfirmModal;
