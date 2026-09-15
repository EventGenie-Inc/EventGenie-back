import { type Request, type Response } from 'express';
declare global {
    namespace Express {
        interface Request {
            rawBody?: Buffer;
        }
    }
}
export declare const captureRawBody: (req: Request, _res: Response, buf: Buffer) => void;
//# sourceMappingURL=raw-body.middleware.d.ts.map