import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { client, lastMail, PASSWORD, signUp, tokenIn } from './helpers';

describe('accounts', () => {
  it('health reports the database and features', async () => {
    const r = await client().get('/api/health');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, features: { email: 'log', storage: 'local', aiImages: false } });
  });

  it('registers, rejects weak passwords and duplicate emails', async () => {
    const c = client();
    const weak = await c.post('/api/auth/register', { email: 'weak@example.com', password: 'short', name: 'W', acceptTerms: true });
    expect(weak.status).toBe(400);
    expect(weak.json.error.fields.password).toMatch(/10 characters/);
    const noTerms = await c.post('/api/auth/register', { email: 'x@example.com', password: PASSWORD, name: 'X' });
    expect(noTerms.status).toBe(400);
    const { email, c: signed } = await signUp();
    const me = await signed.get('/api/auth/me');
    expect(me.json.user.email).toBe(email);
    expect(me.json.user.emailVerified).toBe(false);
    const dup = await client().post('/api/auth/register', { email: email.toUpperCase(), password: PASSWORD, name: 'Dup', acceptTerms: true });
    expect(dup.status).toBe(409);
  });

  it('verifies email from the link in the welcome email', async () => {
    const { c, email } = await signUp();
    const mail = lastMail(email)!;
    expect(mail.template).toBe('verify');
    const r = await c.post('/api/auth/verify', { token: tokenIn(mail.text) });
    expect(r.status).toBe(200);
    expect((await c.get('/api/auth/me')).json.user.emailVerified).toBe(true);
    const again = await c.post('/api/auth/verify', { token: tokenIn(mail.text) });
    expect(again.status).toBe(400);
  });

  it('makes the ADMIN_EMAIL owner the first admin once they confirm their email', async () => {
    const prev = config.adminEmail;
    try {
      config.adminEmail = 'Owner@Example.com';
      const c = client();
      await c.post('/api/auth/register', { email: 'owner@example.com', password: PASSWORD, name: 'Owner', acceptTerms: true });
      expect((await c.get('/api/auth/me')).json.user.role).toBe('member');
      await c.post('/api/auth/verify', { token: tokenIn(lastMail('owner@example.com')!.text) });
      expect((await c.get('/api/auth/me')).json.user.role).toBe('admin');
    } finally { config.adminEmail = prev; }
  });

  it('logs in and out; wrong passwords get one generic message', async () => {
    const { email, c } = await signUp();
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).json.user).toBeNull();
    const bad = await c.post('/api/auth/login', { email, password: 'not the password' });
    expect(bad.status).toBe(401);
    const unknown = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever12345' });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.message).toBe(bad.json.error.message);
    const ok = await c.post('/api/auth/login', { email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(c.cookie).toMatch(/^sk_session=/);
  });

  it('resets a forgotten password and signs out other sessions', async () => {
    const { email, c: oldDevice } = await signUp();
    const anon = client();
    const r = await anon.post('/api/auth/forgot', { email });
    expect(r.status).toBe(200);
    expect((await anon.post('/api/auth/forgot', { email: 'nobody@example.com' })).status).toBe(200); // same answer
    const mail = lastMail(email)!;
    expect(mail.template).toBe('reset');
    const reset = await anon.post('/api/auth/reset', { token: tokenIn(mail.text), password: 'a brand new passphrase' });
    expect(reset.status).toBe(200);
    expect((await oldDevice.get('/api/auth/me')).json.user).toBeNull();
    expect((await client().post('/api/auth/login', { email, password: 'a brand new passphrase' })).status).toBe(200);
  });

  it('blocks state-changing requests from other websites', async () => {
    const { c } = await signUp();
    const r = await c.post('/api/me/searches', { query: 'E17' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    const ok = await c.post('/api/me/searches', { query: 'E17' }, { origin: 'http://streetkey.test' });
    expect(ok.status).toBe(201);
  });

  it('exports and deletes personal data', async () => {
    const { c, email } = await signUp();
    await c.put('/api/me/saved/wal-001');
    const exp = await c.get('/api/me/export');
    expect(exp.json.account.email).toBe(email);
    expect(exp.json.savedHomes).toHaveLength(1);
    expect((await c.del('/api/me', { password: 'wrong password!!' })).status).toBe(400);
    expect((await c.del('/api/me', { password: PASSWORD })).status).toBe(200);
    expect((await client().post('/api/auth/login', { email, password: PASSWORD })).status).toBe(401);
  });
});
