import { type PlatformRole } from '@prisma/client';
import { guestDocumentRepository } from './guest-document.repository.js';
import { type DocumentLinkView, type OrganiserDocumentListItem } from './guest-document.types.js';
import { eventService } from '../event/event.service.js';
import { guestDocumentFolders, isGuestDocumentPublicIdInAnyFolder } from '../upload/upload-folders.js';
import { buildPrivateDownloadUrl } from '../../shared/cloudinary/cloudinary-private-asset.util.js';
import { HttpError } from '../../shared/errors/http-error.js';

// The organiser's side of guest documents, apart from the core service
// because it needs eventService, and modules eventService imports (the
// document storage view) reach the core: one file each way keeps them out
// of an import cycle.

// Long enough to start a download on a slow connection (Cloudinary checks
// the expiry when it starts), short enough that a forwarded link is dead
// by the time anyone else opens it. Every view mints a new one.
export const DOCUMENT_LINK_TTL_MS = 5 * 60 * 1000;

const NOT_FOUND_MESSAGE = 'Document not found';

export const guestDocumentOrganiserService = {
  // GET /api/events/:eventId/documents: every document of the event still
  // kept and answered (attached), oldest first, with whose it is and which
  // question it answers. Read-only, for a live or an ARCHIVED event (whose
  // guest list is closed, so this is the only way to reach its documents in
  // the 30 days they are kept). Tenant scoping and the assignment lock as
  // ever, through eventService.getScoped.
  list: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<{ documents: OrganiserDocumentListItem[] }> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId, true);
    const folders = guestDocumentFolders(event.tenantId, event.id);
    const rows = await guestDocumentRepository.findKeptAttachedForEvent(event.id);
    return {
      documents: rows
        .filter((d) => isGuestDocumentPublicIdInAnyFolder(d.cloudinaryPublicId, folders))
        .map((d) => ({
          id: d.id,
          fileName: d.fileName,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          uploadedAt: d.uploadedAt,
          question: { id: d.rsvpField.id, label: d.rsvpField.label },
          guest: d.invite?.guest
            ? { id: d.invite.guest.id, firstName: d.invite.guest.firstName, surname: d.invite.guest.surname, isArchived: d.invite.guest.isArchived || d.invite.isArchived }
            : null,
        })),
    };
  },

  // GET /api/events/:eventId/documents/:documentId/link. The event through
  // eventService.getScoped (tenant scoping and the assignment lock; an
  // archived event too, read-only: its documents are kept 30 days), then the
  // document must be THAT event's, answered (attached) and still kept.
  // Every other case is the same 404, so nobody learns a document exists.
  getLink: async (
    eventId: string,
    documentId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    now: Date = new Date()
  ): Promise<DocumentLinkView> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId, true);
    const doc = await guestDocumentRepository.findById(documentId);
    if (
      !doc ||
      doc.eventId !== event.id ||
      doc.attachedAt === null ||
      doc.deletedAt !== null ||
      doc.deleteRequestedAt !== null ||
      !isGuestDocumentPublicIdInAnyFolder(doc.cloudinaryPublicId, guestDocumentFolders(event.tenantId, event.id))
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
