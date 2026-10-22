import type { RequestHandler } from 'express';
import { Errors, getContext, type AuthService } from '@nse/core';

export function authenticate(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(Errors.unauthorized());
    try {
      const claims = auth.verifyToken(token);
      req.userId = claims.sub;
      const ctx = getContext();
      if (ctx) ctx.userId = claims.sub;
      next();
    } catch (err) {
      next(err);
    }
  };
}
