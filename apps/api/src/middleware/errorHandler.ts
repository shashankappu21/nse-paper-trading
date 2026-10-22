import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorResponse } from '@nse/shared';
import { AppError, Errors, getLogger } from '@nse/core';

export const notFound: RequestHandler = (req, _res, next) => next(Errors.notFound(`Route ${req.method} ${req.path}`));

/** Every error leaves the API in the same shape: { error: { code, message, details?, requestId } }. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;
  if (err instanceof AppError) {
    appErr = err;
  } else if (err?.type === 'entity.parse.failed') {
    appErr = Errors.validation('Malformed JSON body');
  } else if (err?.type === 'entity.too.large') {
    appErr = new AppError('VALIDATION_ERROR', 413, 'Request body too large');
  } else {
    getLogger().error({ err }, 'unhandled error');
    appErr = new AppError('INTERNAL_ERROR', 500, 'Something went wrong');
  }
  if (appErr.status >= 500 && err instanceof AppError) getLogger().warn({ err }, 'server error');

  const body: ErrorResponse = {
    error: { code: appErr.code, message: appErr.message, details: appErr.details, requestId: req.id as string },
  };
  res.status(appErr.status).json(body);
};
