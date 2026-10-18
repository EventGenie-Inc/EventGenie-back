import { Prisma } from '@prisma/client';

// True when err is a unique-constraint violation (P2002) on model.field —
// e.g. two simultaneous creations racing past a "does this email exist?"
// pre-check. Lets a caller turn that race into the same HttpError the
// pre-check gives, instead of a 500.
//
// Where Prisma names the violated constraint depends on the driver: with a
// driver adapter (this repo's Neon and pg adapters), meta.target is absent
// and the index name arrives as meta.driverAdapterError.cause.constraint
// .index, e.g. "User_email_key" (seen on the test database); without one,
// meta.target lists the fields. Both are checked. Prisma's default index
// name is `<Model>_<field>_key`.
export const isUniqueViolationOn = (err: unknown, model: string, field: string): boolean => {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const meta = (err.meta ?? {}) as {
    target?: unknown;
    driverAdapterError?: { cause?: { constraint?: { index?: unknown; fields?: unknown } } };
  };

  const target = meta.target;
  if (Array.isArray(target) && target.includes(field)) return true;
  if (typeof target === 'string' && (target === field || target === `${model}_${field}_key`)) return true;

  const constraint = meta.driverAdapterError?.cause?.constraint;
  if (constraint?.index === `${model}_${field}_key`) return true;
  if (Array.isArray(constraint?.fields) && constraint.fields.some((f) => f === field || f === `"${field}"`)) return true;

  return false;
};

// True when err is a unique-constraint violation (P2002) of the named index:
// for an index Prisma's schema can't express (a partial or expression index,
// created only in a migration), where there is no model field to match on.
// Same two places to look as above.
export const isUniqueViolationOfIndex = (err: unknown, indexName: string): boolean => {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const meta = (err.meta ?? {}) as {
    target?: unknown;
    driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
  };
  if (meta.target === indexName || (Array.isArray(meta.target) && meta.target.includes(indexName))) return true;
  return meta.driverAdapterError?.cause?.constraint?.index === indexName;
};

// True when err is Prisma's "the record to update was not found" (P2025),
// which a conditional update (a `where` beyond the id) throws when the
// condition no longer holds.
export const isRecordNotFound = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
