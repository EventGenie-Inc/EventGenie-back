interface TemplateEvent {
    id: string;
    name: string;
}
interface TemplateEventDay {
    id: string;
    label: string;
    date: Date;
}
export declare const buildImportTemplateWorkbook: (event: TemplateEvent, eventDays: TemplateEventDay[]) => Promise<{
    buffer: Buffer;
    filename: string;
}>;
export {};
//# sourceMappingURL=guest-template.util.d.ts.map