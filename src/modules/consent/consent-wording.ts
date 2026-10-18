import { type ConsentKind } from '@prisma/client';

// ─────────────────────────────────────────
//  CONSENT WORDING — every permission's words, in one place
//
//  What a person is shown when they give (or withdraw) a permission, and
//  what is stored on their ConsentRecord beside its version. The frontend
//  shows the text it is sent (GET /api/events/:eventId/feedback, guest-view's
//  publicSharing), never a copy of its own, so what was shown and what was
//  recorded are the same words.
//
//  Changing the words means a NEW version, appended to the kind's list:
//  never edit or remove an old entry. Records keep the wording they were
//  given (the text is stored on each one), and the list is the history a
//  reviewer reads. The current wording is the last entry.
// ─────────────────────────────────────────

export interface ConsentWording {
  version: number;
  text: string;
}

export const CONSENT_WORDING_HISTORY: Record<ConsentKind, readonly ConsentWording[]> = {
  COMPANY_NAME_LOGO: [
    {
      version: 1,
      text: "e-velope may show our company's name and logo on its website and social media as a company that has used e-velope.",
    },
  ],
  QUOTE: [
    {
      version: 1,
      text: "e-velope may quote this feedback, with our company's name, on its website and social media.",
    },
  ],
  CASE_STUDY_CONTACT: [
    {
      version: 1,
      text: 'e-velope may contact us about taking part in a short case study.',
    },
  ],
  PHOTO_ORGANISER_SELECTED: [
    {
      version: 1,
      text:
        "e-velope may share the photos we've selected from this event on its website and social media. " +
        'Only photos whose guests have also agreed will be shared.',
    },
  ],
  PHOTO_GUEST_PUBLIC_SHARING: [
    {
      version: 1,
      text: 'Happy for this photo to be shared publicly by the organiser and e-velope.',
    },
  ],
};

export const currentConsentWording = (kind: ConsentKind): ConsentWording => {
  const history = CONSENT_WORDING_HISTORY[kind];
  return history[history.length - 1] as ConsentWording;
};
