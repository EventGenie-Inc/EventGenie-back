import { type Prisma } from '@prisma/client';
export declare const assertValidCoordinates: (latitude: number | null | undefined, longitude: number | null | undefined) => void;
type DecimalCoordinates = {
    latitude: Prisma.Decimal | null;
    longitude: Prisma.Decimal | null;
};
type PlainCoordinates<T extends DecimalCoordinates> = Omit<T, 'latitude' | 'longitude'> & {
    latitude: number | null;
    longitude: number | null;
};
export declare const withPlainDayCoordinates: <T extends DecimalCoordinates>(row: T) => PlainCoordinates<T>;
type PlainEvent<T extends DecimalCoordinates> = Omit<PlainCoordinates<T>, 'eventDays'> & (T extends {
    eventDays: (infer D)[];
} ? {
    eventDays: D extends DecimalCoordinates ? PlainCoordinates<D>[] : D[];
} : unknown);
export declare const withPlainCoordinates: <T extends DecimalCoordinates>(event: T) => PlainEvent<T>;
export {};
//# sourceMappingURL=event-coordinates.util.d.ts.map