export declare const forgotPasswordLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const forgotPasswordEmailLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const requestOtpLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const verifyOtpLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const exchangeSessionLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const deviceLimiterKey: (rawDeviceToken: string) => string;
export declare const exchangeSessionDeviceLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const logoutLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const addressAutosuggestLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const uploadSignatureLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const memoryHubGalleryLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const memoryHubGuestUploadLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const rsvpProgramLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const memoryHubGuestViewLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const ticketQuoteLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const publicEventViewLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const publicRegistrationIpLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const publicRegistrationEventLimiter: import("express-rate-limit").RateLimitRequestHandler;
//# sourceMappingURL=rate-limit.middleware.d.ts.map