import express, { type Router } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** dist/public, whether running from dist/ (production) or src/ (tsx in development). */
export const DEFAULT_WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'public');

// Paths that belong to the server, never to the web app's client-side routes.
const SERVER_PATHS = /^\/(api|mcp|oauth|\.well-known|authorize|token|register|revoke|healthz)(\/|$)/;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: https://i.ytimg.com",
  // Video players load only when tapped.
  'frame-src https://www.youtube-nocookie.com https://www.instagram.com',
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function webAppRouter(webDir = DEFAULT_WEB_DIR): Router {
  const router = express.Router();
  const index = path.join(webDir, 'index.html');
  if (!existsSync(index)) {
    router.get('/', (_req, res) => {
      res.type('text').send('BJJ Notes server. The web app is not built here (npm run build). Claude connects at /mcp.');
    });
    return router;
  }
  const headers = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
  // Hashed build output never changes; everything else is revalidated.
  router.use('/assets', express.static(path.join(webDir, 'assets'), { immutable: true, maxAge: '365d', index: false, fallthrough: false }));
  router.use(
    express.static(webDir, {
      index: false,
      maxAge: 0,
      setHeaders: res => res.set('X-Content-Type-Options', 'nosniff'),
    }),
  );
  router.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || SERVER_PATHS.test(req.path)) return next();
    if (path.extname(req.path)) return next(); // a missing file, not an app route
    res.set({ ...headers, 'Cache-Control': 'no-cache' }).sendFile(index);
  });
  return router;
}
