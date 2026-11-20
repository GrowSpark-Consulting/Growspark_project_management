/**
 * Validation for company registration, invitations and password changes.
 * Pure functions: the registration page and the API use the same rules and messages.
 */

export const TERMS_VERSION = '2026-11-20';
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72; // bcrypt (Supabase Auth) ignores anything longer

const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'assets', 'auth', 'client-portal', 'client-invite', 'dashboard', 'help', 'invite',
  'login', 'logout', 'mail', 'manager', 'onboarding', 'privacy', 'projects', 'register', 'reset-password',
  'settings', 'setup', 'signup', 'static', 'status', 'support', 'terms', 'welcome', 'www',
]);

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Problems with a password, or [] when it is acceptable. */
export function passwordProblems(password: string, email?: string): string[] {
  const p: string[] = [];
  if (password.length < PASSWORD_MIN) p.push(`at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) p.push(`at most ${PASSWORD_MAX} characters`);
  if (!/[A-Za-z]/.test(password)) p.push('a letter');
  if (!/\d/.test(password)) p.push('a number');
  const local = (email || '').split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) p.push('not your email name');
  return p;
}

export function passwordMessage(password: string, email?: string): string | null {
  const p = passwordProblems(password, email);
  return p.length ? `Password needs ${p.join(', ')}` : null;
}

/** +, digits, spaces, dashes and brackets; 7–15 digits; returns "+919876543210" style or null. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[0-9 ()-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || digits.startsWith('0') && trimmed.startsWith('+')) return null;
  return (trimmed.startsWith('+') ? '+' : '') + digits;
}

export function slugify(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/** null when the slug can be used, otherwise why not. */
export function slugProblem(slug: string): string | null {
  if (!slug) return 'Choose a workspace URL';
  if (slug.length < 3) return 'Workspace URL must be at least 3 characters';
  if (slug.length > 40) return 'Workspace URL must be at most 40 characters';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])$/.test(slug)) return 'Use lowercase letters, numbers and dashes (not at the start or end)';
  if (slug.includes('--')) return 'Workspace URL cannot contain two dashes in a row';
  if (RESERVED_SLUGS.has(slug)) return 'That workspace URL is reserved, choose another';
  return null;
}

export interface RegistrationInput {
  companyName: string;
  workspaceName: string;
  workspaceSlug: string;
  name: string;
  email: string;
  password: string;
  phone: string;
  acceptTerms: boolean;
  registrationCode?: string;
}

/** Field → message for every problem in the form ({} when valid). */
export function registrationErrors(i: Partial<RegistrationInput>): Record<string, string> {
  const e: Record<string, string> = {};
  const companyName = (i.companyName || '').trim();
  const workspaceName = (i.workspaceName || '').trim();
  const name = (i.name || '').trim();
  const email = (i.email || '').trim().toLowerCase();
  if (companyName.length < 2) e.companyName = 'Enter your company or organisation name';
  else if (companyName.length > 120) e.companyName = 'Company name must be at most 120 characters';
  if (workspaceName.length < 2) e.workspaceName = 'Enter a workspace name';
  else if (workspaceName.length > 80) e.workspaceName = 'Workspace name must be at most 80 characters';
  const slug = slugProblem((i.workspaceSlug || '').trim());
  if (slug) e.workspaceSlug = slug;
  if (name.length < 2) e.name = 'Enter your full name';
  else if (name.length > 120) e.name = 'Name must be at most 120 characters';
  if (!email) e.email = 'Enter your business email';
  else if (!EMAIL_RE.test(email) || email.length > 254) e.email = 'Enter a valid email address';
  const pw = passwordMessage(i.password || '', email);
  if (pw) e.password = pw;
  if (!(i.phone || '').trim()) e.phone = 'Enter a phone number';
  else if (!normalizePhone(i.phone || '')) e.phone = 'Enter a valid phone number, for example +91 98765 43210';
  if (i.acceptTerms !== true) e.acceptTerms = 'Please accept the Terms of Service and Privacy Policy';
  return e;
}
