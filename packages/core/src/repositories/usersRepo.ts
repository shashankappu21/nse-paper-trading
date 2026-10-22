import type { Db } from '../db/pool';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
}

export const usersRepo = {
  async insert(db: Db, u: { email: string; name: string; passwordHash: string }): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [u.email, u.name, u.passwordHash],
    );
    return rows[0] ?? null;
  },

  async findByEmail(db: Db, email: string): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ?? null;
  },

  async findById(db: Db, id: string): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  /**
   * Row lock on the user. Every operation that reads-then-writes a user's cash or
   * holdings takes this lock first, so per-user money movements are serialised.
   */
  async lock(db: Db, id: string): Promise<boolean> {
    const { rowCount } = await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
    return rowCount === 1;
  },
};
