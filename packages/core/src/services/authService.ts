import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { AuthResponse, LoginInput, MeResponse, RegisterInput } from '@nse/shared';
import type { Config } from '../config';
import { withTransaction, type Pool } from '../db/pool';
import { Errors } from '../errors';
import { toPaise, toRupees } from '../money';
import { ledgerRepo } from '../repositories/ledgerRepo';
import { usersRepo } from '../repositories/usersRepo';
import { userToDto } from './mappers';

export interface TokenClaims {
  sub: string;
  email: string;
}

type AuthConfig = Pick<Config, 'JWT_SECRET' | 'JWT_EXPIRES_IN' | 'BCRYPT_ROUNDS' | 'STARTING_CASH'>;

// Compared against when the email is unknown so login timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 4);

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly cfg: AuthConfig,
  ) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    const passwordHash = await bcrypt.hash(input.password, this.cfg.BCRYPT_ROUNDS);
    const user = await withTransaction(this.pool, async (tx) => {
      const created = await usersRepo.insert(tx, { email: input.email, name: input.name, passwordHash });
      if (!created) throw Errors.emailTaken();
      // Starting cash is a ledger entry like any other balance change.
      await ledgerRepo.insert(tx, { userId: created.id, amount: toPaise(this.cfg.STARTING_CASH), reason: 'DEPOSIT' });
      return created;
    });
    return { token: this.sign(user.id, user.email), user: userToDto(user) };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await usersRepo.findByEmail(this.pool, input.email);
    const ok = await bcrypt.compare(input.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw Errors.invalidCredentials();
    return { token: this.sign(user.id, user.email), user: userToDto(user) };
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await usersRepo.findById(this.pool, userId);
    if (!user) throw Errors.unauthorized('User no longer exists');
    return { user: userToDto(user), cash: toRupees(await ledgerRepo.balance(this.pool, userId)) };
  }

  verifyToken(token: string): TokenClaims {
    try {
      const claims = jwt.verify(token, this.cfg.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (typeof claims.sub !== 'string') throw new Error('missing sub');
      return { sub: claims.sub, email: String(claims.email) };
    } catch {
      throw Errors.unauthorized('Invalid or expired token');
    }
  }

  private sign(userId: string, email: string): string {
    return jwt.sign({ email }, this.cfg.JWT_SECRET, {
      subject: userId,
      algorithm: 'HS256',
      expiresIn: this.cfg.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    });
  }
}
