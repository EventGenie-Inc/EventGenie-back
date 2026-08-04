import { type Request, type Response, type NextFunction } from 'express';
declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                firebaseUid: string;
                email: string;
                role: string;
                tenantId: string | null;
                vendorSpaceId: string | null;
            };
        }
    }
}
export declare const authenticate: (req: Request, res: Response, next: NextFunction) => Promise<void>;
//# sourceMappingURL=auth.middleware.d.ts.map