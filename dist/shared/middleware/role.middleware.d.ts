import { type Request, type Response, type NextFunction } from 'express';
import { PlatformRole } from '@prisma/client';
export declare const requireRole: (...allowedRoles: PlatformRole[]) => (req: Request, res: Response, next: NextFunction) => void;
export declare const requireSuperAdmin: (req: Request, res: Response, next: NextFunction) => void;
export declare const requireTenantAdmin: (req: Request, res: Response, next: NextFunction) => void;
export declare const requireEventAdmin: (req: Request, res: Response, next: NextFunction) => void;
export declare const requireVendor: (req: Request, res: Response, next: NextFunction) => void;
export declare const requireEventAdminOrVendor: (req: Request, res: Response, next: NextFunction) => void;
export declare const requireVendorSpaceOwner: (paramName: string) => (req: Request, res: Response, next: NextFunction) => Promise<void>;
//# sourceMappingURL=role.middleware.d.ts.map