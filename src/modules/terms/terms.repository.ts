import prisma from '../../shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  TERMS ACCEPTANCES — APPEND-ONLY
//
//  Inserts and reads, nothing else: there is deliberately no update or
//  delete method here, and the database refuses an UPDATE anyway (the
//  TermsAcceptance_no_update trigger). Accepting a newer version is a new
//  row; accepting the same version again adds nothing.
// ─────────────────────────────────────────
export const termsRepository = {
  // ON CONFLICT DO NOTHING on (userId, version): a second accept, or two
  // tabs accepting at once, keeps the first row and is never an error.
  append: (userId: string, version: string) =>
    prisma.termsAcceptance.createMany({ data: [{ userId, version }], skipDuplicates: true }),

  findLatest: (userId: string) =>
    prisma.termsAcceptance.findFirst({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
      select: { version: true, acceptedAt: true },
    }),

  hasAccepted: async (userId: string, version: string): Promise<boolean> =>
    (await prisma.termsAcceptance.count({ where: { userId, version } })) > 0,
};
