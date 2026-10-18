import prisma from '../../shared/prisma/prisma.client.js';

const DATABASE_PING_TIMEOUT_MS = 3000;

export const systemHealthRepository = {
  // Whether the database answers a trivial query within the timeout.
  pingDatabase: async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), DATABASE_PING_TIMEOUT_MS);
    });
    try {
      return await Promise.race([prisma.$queryRaw`SELECT 1`.then(() => true as const), timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },
};
