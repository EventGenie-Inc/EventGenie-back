import { type PlatformRole } from '@prisma/client';
import { guestDocumentRepository } from './guest-document.repository.js';
import { type DocumentLinkView } from './guest-document.types.js';
import { eventService } from '../event/event.service.js';
import { guestDocumentFolder, isGuestDocumentPublicIdInFolder } from '../upload/upload-folders.js';
import { buildPrivateDownloadUrl } from '../../shared/cloudinary/cloudinary-private-asset.util.js';
import { HttpError } from '../../shared/errors/http-error.js';

// The organiser's side of guest documents, apart from the core service
// because it needs eventService, and event.service.ts calls the core
// (deleteForEvent): one file each way keeps the two out of an import cycle.

// Long enough to start a download on a slow connection (Cloudinary checks
// the expiry when it starts), short enough that a forwarded link is dead
// by the time anyone else opens it. Every view mints a new one.
export const DOCUMENT_LINK_TTL_MS = 5 * 60 * 1000;

const NOT_FOUND_MESSAGE = 'Document not found';

export const guestDocumentOrganiserService = {
  // GET /api/events/:eventId/documents/:documentId/link. The event through
  // eventService.getScoped (tenant scoping and the assignment lock; an
  // archived event is a 404, and its files are deleted anyway), then the
  // document must be THAT event's, answered (attached) and still kept.
  // Every other case is the same 404, so nobody learns a document exists.
  getLink: async (
    eventId: string,
    documentId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    now: Date = new Date()
  ): Promise<DocumentLinkView> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    const doc = await guestDocumentRepository.findById(documentId);
    if (
      !doc ||
      doc.eventId !== event.id ||
      doc.attachedAt === null ||
      doc.deletedAt !== null ||
      doc.deleteRequestedAt !== null ||
      !isGuestDocumentPublicIdInFolder(doc.cloudinaryPublicId, guestDocumentFolder(event.tenantId, event.id))
    ) {
      throw new HttpError(404, NOT_FOUND_MESSAGE);
    }

    const expiresAt = new Date(now.getTime() + DOCUMENT_LINK_TTL_MS);
    return {
      url: buildPrivateDownloadUrl(doc.cloudinaryPublicId, expiresAt, now),
      expiresAt,
      fileName: doc.fileName,
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes,
    };
  },
};
