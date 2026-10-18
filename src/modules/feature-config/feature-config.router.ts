import { Router, type Request, type Response } from 'express';
import { getFeatureFlags } from '../../shared/features/feature-flags.js';

// Public, no authentication: the frontend reads this before anyone signs
// in, to decide which navigation, routes and buttons exist at all. It is
// the frontend's only source for the flags; it keeps no copy of its own.
// Carries nothing but a boolean per feature name (feature-flags.ts).
const router = Router();

// GET /api/config/features -> { vendors: true, ticketing: false, ... }
router.get('/features', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', data: getFeatureFlags() });
});

export default router;
