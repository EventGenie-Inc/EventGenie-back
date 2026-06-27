import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';

const app: Application = express();

// ─────────────────────────────────────────
//  CORS
//  Open for now. When frontend URL is known,
//  replace with:
//  origin: process.env.FRONTEND_URL
// ─────────────────────────────────────────
app.use(cors());

// ─────────────────────────────────────────
//  BODY PARSERS
// ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────
//  HEALTH CHECK
//  Simple endpoint to confirm the server
//  is running and reachable.
// ─────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'EventGenie API',
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────
//  ROUTES
//  Modules are registered here as they
//  are built. Each module mounts on its
//  own base path.
//
//  Example (uncomment as you build):
//  import authRouter from './modules/auth/auth.router.js';
//  app.use('/api/auth', authRouter);
// ─────────────────────────────────────────

// ─────────────────────────────────────────
//  404 HANDLER
//  Catches any request that did not match
//  a registered route.
// ─────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    message: 'Route not found',
  });
});

// ─────────────────────────────────────────
//  GLOBAL ERROR HANDLER
//  Catches any error passed via next(error)
//  from routes or middleware.
// ─────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[ERROR] ${err.message}`);

  res.status(500).json({
    status: 'error',
    message:
      process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message,
  });
});

export default app;