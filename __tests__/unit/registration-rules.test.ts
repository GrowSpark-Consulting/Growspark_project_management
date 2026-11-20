import { describe, it, expect } from 'vitest';
import { registrationErrors, passwordProblems, normalizePhone, slugProblem, slugify } from '@/lib/registration-rules';

const good = {
  companyName: 'Grow Spark Technologies', workspaceName: 'Grow Spark', workspaceSlug: 'growspark', name: 'Priya Manager',
  email: 'manager@company.com', password: 'Strong123', phone: '+91 98765 43210', acceptTerms: true,
};

describe('registrationErrors', () => {
  it('accepts a complete, valid form', () => expect(registrationErrors(good)).toEqual({}));
  it('requires every field and the terms', () => {
    expect(Object.keys(registrationErrors({})).sort()).toEqual(['acceptTerms', 'companyName', 'email', 'name', 'password', 'phone', 'workspaceName', 'workspaceSlug']);
  });
  it('rejects a bad email, weak password, bad phone and reserved URL', () => {
    const e = registrationErrors({ ...good, email: 'not-an-email', password: 'short', phone: 'call me', workspaceSlug: 'admin' });
    expect(e.email).toMatch(/valid email/);
    expect(e.password).toMatch(/8 characters/);
    expect(e.phone).toMatch(/valid phone/);
    expect(e.workspaceSlug).toMatch(/reserved/);
  });
});

describe('passwordProblems', () => {
  it('needs 8+ characters, a letter and a number', () => {
    expect(passwordProblems('Strong123')).toEqual([]);
    expect(passwordProblems('abcdefgh')).toContain('a number');
    expect(passwordProblems('12345678')).toContain('a letter');
    expect(passwordProblems('a1')).toContain('at least 8 characters');
  });
  it('rejects a password containing the email name', () => {
    expect(passwordProblems('priya2026x', 'priya@company.com')).toContain('not your email name');
  });
});

describe('normalizePhone', () => {
  it('keeps + and digits', () => expect(normalizePhone('+91 98765-43210')).toBe('+919876543210'));
  it('accepts local numbers', () => expect(normalizePhone('(022) 2345 6789')).toBe('02223456789'));
  it('rejects letters, too short and too long', () => {
    expect(normalizePhone('98765abc')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1234567890123456')).toBeNull();
  });
});

describe('workspace URL', () => {
  it('suggests a URL from the company name', () => expect(slugify('Grow Spark Technologies!')).toBe('grow-spark-technologies'));
  it('validates format and length', () => {
    expect(slugProblem('growspark')).toBeNull();
    expect(slugProblem('gs')).toMatch(/at least 3/);
    expect(slugProblem('-gs-')).toMatch(/lowercase/);
    expect(slugProblem('Grow')).toMatch(/lowercase/);
    expect(slugProblem('a--b')).toMatch(/two dashes/);
  });
});
