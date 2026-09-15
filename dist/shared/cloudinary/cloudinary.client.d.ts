interface CloudinaryConfig {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
}
export declare const requireCloudinaryConfig: () => CloudinaryConfig;
export interface DestroyResult {
    ok: boolean;
    reason?: string;
}
export declare const destroyAsset: (publicId: string, resourceType?: "image" | "video") => Promise<DestroyResult>;
export {};
//# sourceMappingURL=cloudinary.client.d.ts.map