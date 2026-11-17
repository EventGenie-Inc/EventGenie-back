import { Router, type Request, type Response } from 'express';
import { smsDeliveryService } from './sms-delivery.service.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';

const router = Router();

// POST /api/sms/delivery-reports — SMSPortal's delivery-report webhook.
// Public and unauthenticated: SMSPortal calls it, and its webhook signature
// (checked first, on the raw bytes) IS the authentication. See
// sms-delivery.service.ts. Up whatever the sms flag says, so reports for
// texts already sent still land, as the Paystack webhook stays up.
router.post('/', async (req: Request, res: Response) => {
  // The URL SMSPortal signed: the public one. trust proxy (app.ts) makes
  // req.protocol Render's https.
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const valid = smsDeliveryService.isValidSignature({
    rawBody: req.rawBody,
    method: req.method,
    url,
    signature: req.headers['smswebhookengine-signature'],
    timestamp: req.headers['smswebhookengine-timestamp'],
  });
  if (!valid) {
    // Nothing read or written on a bad signature.
    console.warn('[sms delivery] rejected — invalid or missing signature');
    res.status(401).json({ status: 'error', message: 'Invalid signature' });
    return;
  }

  try {
    const outcome = await smsDeliveryService.process(req.body);
    res.status(200).json({ status: 'ok', outcome });
  } catch (err) {
    // Recording failed: a 500 makes SMSPortal try again.
    console.error('[sms delivery] processing failed');
    reportError(err, req, res);
    res.status(500).json({ status: 'error', message: 'Delivery report processing failed' });
  }
});

export default router;
