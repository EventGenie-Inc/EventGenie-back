import { type Prisma } from '@prisma/client';
export declare const assertValidCoordinates: (latitude: number | null | undefined, longitude: number | null | undefined) => void;
export declare const withPlainCoordinates: <T extends {
    latitude: Prisma.Decimal | null;
    longitude: Prisma.Decimal | null;
}>(event: T) => Omit<T, "latitude" | "longitude"> & {
    latitude: number | null;
    longitude: number | null;
};
//# sourceMappingURL=event-coordinates.util.d.ts.map