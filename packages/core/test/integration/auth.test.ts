import { AuthService, type Pool } from '../../src';
import { config, resetDb, testPool, uniqueEmail } from '../helpers';

describe('AuthService', () => {
  let pool: Pool;
  let auth: AuthService;
  beforeAll(() => {
    pool = testPool();
    auth = new AuthService(pool, config);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDb(pool));

  it('registers, hashes the password and issues a verifiable JWT', async () => {
    const email = uniqueEmail();
    const res = await auth.register({ email, password: 'password123', name: 'A' });
    expect(res.user.email).toBe(email);
    expect(auth.verifyToken(res.token).sub).toBe(res.user.id);
    const row = await pool.query('SELECT password_hash FROM users WHERE id = $1', [res.user.id]);
    expect(row.rows[0].password_hash).toMatch(/^\$2[aby]\$/);
  });

  it('rejects duplicate emails', async () => {
    const email = uniqueEmail();
    await auth.register({ email, password: 'password123', name: 'A' });
    await expect(auth.register({ email, password: 'password123', name: 'B' })).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('logs in with the right password only', async () => {
    const email = uniqueEmail();
    await auth.register({ email, password: 'password123', name: 'A' });
    await expect(auth.login({ email, password: 'password123' })).resolves.toHaveProperty('token');
    await expect(auth.login({ email, password: 'wrong-pass' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(auth.login({ email: uniqueEmail(), password: 'x' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('rejects tampered tokens', () => {
    expect(() => auth.verifyToken('not.a.jwt')).toThrow();
  });
});
