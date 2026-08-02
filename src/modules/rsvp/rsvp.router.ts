import { Router, type Request, type Response, type NextFunction } from 'express';
import { rsvpService } from './rsvp.service.js';

// Fully public surface — a guest only has a bare invite token, never a
// platform session. No auth middleware anywhere in this file.
const router = Router();

// GET /api/rsvp/validate/:token
router.get('/validate/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rsvpService.validate(req.params['token'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/rsvp/submit
router.post('/submit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rsvpService.submit(req.body);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
