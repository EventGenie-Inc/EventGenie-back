import { defineConfig } from 'prisma/config';
import dotenv from 'dotenv';

dotenv.config();

const getDatabaseUrl = (): string => {
  const env = process.env.NODE_ENV ?? 'development';

  if (env === 'production') {
    const url = process.env.DATABASE_URL_PROD_DIRECT;
    if (!url) throw new Error('DATABASE_URL_PROD_DIRECT is not defined in .env');
    return url;
  }

  const url = process.env.DATABASE_URL_DEV_DIRECT;
  if (!url) throw new Error('DATABASE_URL_DEV_DIRECT is not defined in .env');
  return url;
};

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: getDatabaseUrl(),
  },
});