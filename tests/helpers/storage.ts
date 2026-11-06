import { storedFileService, type SignUploadInput } from '../../src/modules/storage/stored-file.service.js';
import { requireCloudinaryConfig } from '../../src/shared/cloudinary/cloudinary.client.js';
import { fakeCloudinary } from './fake-cloudinary.js';
import { prisma } from './db.js';

// ─────────────────────────────────────────
//  An upload, as the browser makes one: signed through the real service
//  (its StoredFile written), then "uploaded" into the fake Cloudinary at
//  `bytes` (Cloudinary's own figure, what the server measures). Pass
//  `uploaded: false` for a signature that was never used.
// ─────────────────────────────────────────

export interface TestUpload {
  publicId: string;
  url: string;
  fileId: string;
}

export const signedUpload = async (
  input: SignUploadInput & { bytes?: number; uploaded?: boolean; format?: string }
): Promise<TestUpload> => {
  const signature = await storedFileService.signUpload(input);
  const publicId = `${signature.folder}/${signature.publicId}`;
  const resourceType = input.mediaType === 'VIDEO' ? 'video' : 'image';
  const format = input.format ?? (resourceType === 'video' ? 'mp4' : 'jpg');
  if (input.uploaded !== false) {
    fakeCloudinary.put(publicId, { bytes: input.bytes ?? 1000, resourceType, format });
  }
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { publicId } });
  const { cloudName } = requireCloudinaryConfig();
  return {
    publicId,
    url: `https://res.cloudinary.com/${cloudName}/${resourceType}/upload/v1700000000/${publicId}.${format}`,
    fileId: file.id,
  };
};

export const storedFile = (publicId: string) => prisma.storedFile.findUniqueOrThrow({ where: { publicId } });
