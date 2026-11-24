'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HeaderBrand } from '@/components/brand-chip';
import { signInWithEmail } from '@/lib/auth';
import { registrationErrors, slugify, slugProblem, passwordProblems, type RegistrationInput } from '@/lib/registration-rules';
import { CLOSED_MESSAGES, type ClosedReason } from '@/lib/registration-state';

type Status =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'open'; requiresCode: boolean }
  | { kind: 'closed'; reason: ClosedReason; workspaceName: string | null; notice?: string }
  // The workspace and account exist, but the automatic sign-in didn't work
  | { kind: 'created'; email: string; problem: string };

const EMPTY: RegistrationInput = {
  companyName: '', workspaceName: '', workspaceSlug: '', name: '', email: '', password: '', phone: '', acceptTerms: false, registrationCode: '',
};
const UNREACHABLE = 'Could not reach the server to check this installation. Nothing has been created.';

/**
 * Company registration. Owns the whole journey: create → sign in → confirm the server sees the
 * session → /manager. `onRegistering` tells the page to stop its own "already signed in" redirect,
 * so only one navigation happens after sign-in (no race).
 */
export function RegistrationForm({ onRegistering }: { onRegistering?: () => void }) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [form, setForm] = useState<RegistrationInput>(EMPTY);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [slugEdited, setSlugEdited] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<'form' | 'creating' | 'signing-in'>('form');
  const appHost = typeof window !== 'undefined' ? window.location.host : '';

  const loadStatus = useCallback(async () => {
    setStatus({ kind: 'loading' });
    try {
      const res = await fetch('/api/register', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.data) {
        setStatus({ kind: 'unavailable', message: body?.error || UNREACHABLE });
      } else if (body.data.open) {
        setStatus({ kind: 'open', requiresCode: !!body.data.requiresCode });
      } else {
        setStatus({ kind: 'closed', reason: body.data.reason || 'registered', workspaceName: body.data.companyName ?? null });
      }
    } catch {
      setStatus({ kind: 'unavailable', message: UNREACHABLE });
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const errors = useMemo(() => ({ ...registrationErrors(form), ...serverErrors }), [form, serverErrors]);
  const show = (f: keyof RegistrationInput) => (touched[f] || touched._submit) && errors[f];
  const set = (f: keyof RegistrationInput, v: string | boolean) => {
    setServerErrors((e) => { const n = { ...e }; delete n[f]; return n; });
    setForm((prev) => {
      const next = { ...prev, [f]: v } as RegistrationInput;
      // Suggest the workspace name and URL from the company name until the user edits them
      if (f === 'companyName' && !slugEdited) {
        next.workspaceSlug = slugify(String(v));
        if (!prev.workspaceName || prev.workspaceName === prev.companyName) next.workspaceName = String(v);
      }
      return next;
    });
  };
  const blur = (f: string) => setTouched((t) => ({ ...t, [f]: true }));
  const pwHints = passwordProblems(form.password, form.email);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setTouched((t) => ({ ...t, _submit: true }));
    setError(null);
    if (Object.keys(registrationErrors(form)).length) return;
    setSubmitting(true);
    setPhase('creating');
    const email = form.email.trim().toLowerCase();

    // 1. Create the workspace and the manager account
    let res: Response;
    let body: { data?: { landing?: string }; error?: string; code?: string; reason?: ClosedReason; workspaceName?: string | null; fieldErrors?: Record<string, string> };
    try {
      res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      body = await res.json().catch(() => ({}));
    } catch {
      setError('Could not reach the server. Nothing was created; check your connection and try again.');
      setPhase('form'); setSubmitting(false);
      return;
    }
    if (!res.ok) {
      if (body.code === 'REGISTRATION_CLOSED') {
        setStatus({ kind: 'closed', reason: body.reason || 'registered', workspaceName: body.workspaceName ?? null, notice: 'Your details were not saved and no account was created.' });
        return;
      }
      if (body.fieldErrors) setServerErrors(body.fieldErrors);
      setError(body.error || `Registration failed (HTTP ${res.status}). Nothing was created.`);
      setPhase('form'); setSubmitting(false);
      return;
    }

    // 2. Sign in with the new account (same Supabase sign-in as the login page), then make sure
    //    the server sees the session before leaving, so /manager can't bounce to /login.
    onRegistering?.();
    setPhase('signing-in');
    try {
      await signInWithEmail(email, form.password);
      const me = await fetch('/api/profile', { cache: 'no-store' });
      const meBody = await me.json().catch(() => null);
      if (!me.ok || meBody?.profile?.email?.toLowerCase() !== email) {
        throw new Error(meBody?.error || `the server did not receive the new session (HTTP ${me.status})`);
      }
    } catch (err) {
      setStatus({ kind: 'created', email, problem: err instanceof Error ? err.message : String(err) });
      return;
    }
    window.location.replace(body.data?.landing || '/manager');
  };

  if (status.kind === 'loading') {
    return <div className="text-center text-sm text-ink-muted">Checking this installation…</div>;
  }

  if (status.kind === 'unavailable') {
    return (
      <Card>
        <CardHeader>
          <HeaderBrand className="mb-2" />
          <CardTitle>Can&apos;t check this installation right now</CardTitle>
          <CardDescription>{status.message}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button className="w-full" onClick={loadStatus}>Try again</Button>
          <Button asChild variant="outline" className="w-full"><Link href="/login">Go to login</Link></Button>
        </CardContent>
      </Card>
    );
  }

  if (status.kind === 'created') {
    return (
      <Card>
        <CardHeader>
          <HeaderBrand className="mb-2" />
          <CardTitle>Your workspace is ready</CardTitle>
          <CardDescription>
            The workspace and your manager account ({status.email}) were created, but signing you in automatically didn&apos;t work: {status.problem}. Log in with the same email and password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full"><a href={`/login?email=${encodeURIComponent(status.email)}&redirectTo=/manager`}>Log in</a></Button>
        </CardContent>
      </Card>
    );
  }

  if (status.kind === 'closed') {
    const msg = CLOSED_MESSAGES[status.reason] ?? CLOSED_MESSAGES.registered;
    return (
      <Card>
        <CardHeader>
          <HeaderBrand className="mb-2" />
          <CardTitle>{msg.title(status.workspaceName)}</CardTitle>
          <CardDescription>{msg.body}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {status.notice && <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-ink">{status.notice}</p>}
          {status.reason === 'in_progress'
            ? <Button className="w-full" onClick={loadStatus}>Check again</Button>
            : <Button asChild className="w-full"><Link href="/login">Go to login</Link></Button>}
        </CardContent>
      </Card>
    );
  }

  const field = (f: keyof RegistrationInput, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: React.ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={f}>{label}</Label>
      <Input id={f} value={String(form[f] ?? '')} aria-invalid={!!show(f)} aria-describedby={`${f}-msg`}
        onChange={(e) => set(f, e.target.value)} onBlur={() => blur(f)} disabled={submitting} {...props} />
      {show(f) ? <p id={`${f}-msg`} className="text-xs text-danger">{errors[f]}</p> : hint ? <p id={`${f}-msg`} className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex items-center justify-between gap-3">
          <HeaderBrand />
          <Button asChild variant="outline" size="sm"><Link href="/login">Log in</Link></Button>
        </div>
        <CardTitle>Create your company workspace</CardTitle>
        <CardDescription>You&apos;ll be the workspace manager. Invite your employees and clients once you&apos;re in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          {field('companyName', 'Company or organisation name', { autoComplete: 'organization', placeholder: 'Grow Spark Technologies', maxLength: 120 })}
          {field('workspaceName', 'Workspace name', { placeholder: 'Grow Spark', maxLength: 80 })}
          <div className="space-y-1.5">
            <Label htmlFor="workspaceSlug">Workspace URL</Label>
            {/* Full width, and the address shortens with "…" rather than spilling out of the box */}
            <div className="flex min-w-0 items-center overflow-hidden rounded-md border border-line-strong bg-surface focus-within:border-primary">
              <span className="min-w-0 shrink truncate pl-3 text-xs text-ink-muted" title={`${appHost}/`}>{appHost}/</span>
              <input id="workspaceSlug" className="h-9 min-w-[7rem] flex-1 bg-transparent px-1 text-sm outline-none" value={form.workspaceSlug} maxLength={40} disabled={submitting}
                aria-invalid={!!show('workspaceSlug')} aria-describedby="workspaceSlug-msg"
                onChange={(e) => { setSlugEdited(true); set('workspaceSlug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); }} onBlur={() => blur('workspaceSlug')} />
            </div>
            {show('workspaceSlug') ? <p id="workspaceSlug-msg" className="text-xs text-danger">{errors.workspaceSlug}</p>
              : form.workspaceSlug && !slugProblem(form.workspaceSlug) ? <p id="workspaceSlug-msg" className="text-xs text-success">Available</p> : null}
          </div>
          {field('name', 'Your full name', { autoComplete: 'name', maxLength: 120 })}
          {field('email', 'Business email', { type: 'email', autoComplete: 'email', placeholder: 'manager@company.com' })}
          {field('password', 'Password', { type: 'password', autoComplete: 'new-password' },
            form.password ? (pwHints.length ? `Still needs ${pwHints.join(', ')}` : 'Strong enough') : `At least 8 characters, with a letter and a number`)}
          {field('phone', 'Phone number', { type: 'tel', autoComplete: 'tel', placeholder: '+91 98765 43210' })}
          {status.requiresCode && field('registrationCode', 'Registration code', { autoComplete: 'off' }, 'Given to you by whoever set up this server')}
          <div className="space-y-1">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={form.acceptTerms} disabled={submitting}
                onChange={(e) => set('acceptTerms', e.target.checked)} onBlur={() => blur('acceptTerms')} aria-describedby="acceptTerms-msg" />
              <span>I agree to the <Link href="/terms" target="_blank" className="underline">Terms of Service</Link> and the <Link href="/privacy" target="_blank" className="underline">Privacy Policy</Link></span>
            </label>
            {show('acceptTerms') && <p id="acceptTerms-msg" className="text-xs text-danger">{errors.acceptTerms}</p>}
          </div>
          {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {phase === 'creating' ? 'Creating your workspace…' : phase === 'signing-in' ? 'Signing you in…' : 'Create workspace'}
          </Button>
          <p className="text-center text-sm text-ink-muted">Already have an account? <Link href="/login" className="underline">Log in</Link></p>
        </form>
      </CardContent>
    </Card>
  );
}
