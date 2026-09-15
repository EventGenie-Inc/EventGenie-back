import { type EngineSendResult } from './messaging.types.js';
export declare const sendEmail: (to: string, subject: string, html: string) => Promise<EngineSendResult>;
export declare const renderBrandEmailShell: (heading: string, bodyHtml: string) => string;
//# sourceMappingURL=email.engine.d.ts.map