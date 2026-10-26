// GET /api/terms/status, and POST /api/terms/accept's response.
// acceptedVersion/acceptedAt are the caller's latest acceptance (null when
// they have never accepted any version); mustAccept is true until they
// have accepted currentVersion itself.
export interface TermsStatus {
  currentVersion: string;
  acceptedVersion: string | null;
  acceptedAt: Date | null;
  mustAccept: boolean;
}

export interface AcceptTermsDto {
  version: string;
}
