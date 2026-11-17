import type { OutgoingSms, SmsProvider, SmsSendOutcome } from './sms-provider.js';

// ─────────────────────────────────────────
//  SMSPORTAL (South African SMS provider) — REST API, docs.smsportal.com
//
//  POST https://rest.smsportal.com/v3/BulkMessages, one message per call
//  (each guest's text carries their own link), authenticated with Basic
//  auth on the REST API key's Client ID and API Secret
//  (SMSPORTAL_CLIENT_ID, SMSPORTAL_API_SECRET). SMSPortal accepts Basic
//  auth on every REST endpoint, so no token is fetched or cached.
//
//  TEST MODE: sendOptions.testMode is true unless SMSPORTAL_TEST_MODE is
//  exactly "false". SMSPortal then answers as if it sent the message but
//  sends nothing ("it will return the result but won't send the data"), so
//  development never texts anyone or spends credits by accident. Real
//  sending is a deliberate SMSPORTAL_TEST_MODE=false.
//
//  The message's customerId is our queue item's id; SMSPortal returns it in
//  the delivery report (sms-delivery module), along with the send's
//  eventId, which we keep as the message's provider id.
//
//  The credentials are never logged, and never part of a reason.
// ─────────────────────────────────────────

export const SMSPORTAL_SEND_URL = 'https://rest.smsportal.com/v3/BulkMessages';
const REQUEST_TIMEOUT_MS = 15_000;

export const isSmsPortalTestMode = (): boolean => process.env.SMSPORTAL_TEST_MODE?.trim().toLowerCase() !== 'false';

interface SmsPortalSendResponse {
  statusCode?: number;
  sendResponse?: {
    eventId?: number | string;
    messages?: number;
    parts?: number;
    errorReport?: {
      noNetwork?: number;
      noContents?: number;
      contentToLong?: number;
      duplicates?: number;
      optedOuts?: number;
      faults?: { errorMessage?: string; status?: string }[];
    };
  };
  errors?: { errorCode?: string; errorMessage?: string }[];
}

// SMSPortal's error codes (docs: REST error codes) in the organiser's words.
const REASONS: Record<string, string> = {
  'DestinationAddress.Invalid': "SMSPortal says this phone number isn't in a valid format.",
  'DestinationAddress.NoNetworkFound': "SMSPortal couldn't find a mobile network for this number.",
  'DestinationAddress.Optout': 'This number has opted out of text messages.',
  DuplicateMessage: 'SMSPortal refused this as a duplicate of a message it already has.',
  InsufficientCredits: 'The SMSPortal account is out of credits.',
  InvalidCredentials: 'SMSPortal refused our credentials.',
  'AuthenticationHeader.Invalid': 'SMSPortal refused our credentials.',
  'AuthenticationHeader.Missing': 'SMSPortal refused our credentials.',
  'EmptySend.NoValidMessages': 'SMSPortal found nothing it could send in this message.',
};

const reasonFor = (code: string | undefined, fallback: string): string => (code && REASONS[code]) || fallback;

const authHeader = (clientId: string, secret: string): string =>
  `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;

// SMSPortal's destination: the MSISDN, digits only (27821234567).
const msisdn = (e164: string): string => e164.replace(/^\+/, '');

// A fetch that failed before any byte reached SMSPortal (no DNS, refused):
// certainly not sent. Anything else (a timeout, a reset) may have been.
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);
const errorCode = (err: unknown): string | undefined =>
  (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;

export const smsPortalProvider: SmsProvider = {
  name: 'smsportal',

  send: async (sms: OutgoingSms): Promise<SmsSendOutcome> => {
    const clientId = process.env.SMSPORTAL_CLIENT_ID?.trim();
    const secret = process.env.SMSPORTAL_API_SECRET?.trim();
    if (!clientId || !secret) {
      console.error('[sms] SMSPORTAL_CLIENT_ID or SMSPORTAL_API_SECRET is not set');
      return { status: 'REJECTED', reason: "Text messages aren't set up on this server, so nothing was sent." };
    }
    const testMode = isSmsPortalTestMode();

    let response: Response;
    try {
      response = await fetch(SMSPORTAL_SEND_URL, {
        method: 'POST',
        headers: { Authorization: authHeader(clientId, secret), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          messages: [{ destination: msisdn(sms.to), content: sms.body, customerId: sms.reference }],
          // allowContentTrimming off: a message is never cut short. Ours
          // are one part by construction anyway.
          sendOptions: { testMode, allowContentTrimming: false },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const code = errorCode(err);
      return code && NOT_SENT_CODES.has(code)
        ? { status: 'RETRY', reason: "Couldn't reach SMSPortal." }
        : { status: 'UNKNOWN', reason: 'SMSPortal did not answer in time.' };
    }

    const body = (await response.json().catch(() => ({}))) as SmsPortalSendResponse;
    const firstError = body.errors?.[0];

    if (response.ok) {
      const sent = body.sendResponse;
      if (sent && (sent.messages ?? 0) > 0) {
        return {
          status: 'ACCEPTED',
          providerMessageId: sent.eventId != null ? String(sent.eventId) : null,
          parts: Math.max(1, sent.parts ?? 1),
          testMode,
        };
      }
      // 200 but nothing enqueued: the error report says why.
      const report = sent?.errorReport;
      const fault = report?.faults?.[0];
      const reason =
        fault?.errorMessage ? `SMSPortal refused it: ${fault.errorMessage}`
        : report?.optedOuts ? REASONS['DestinationAddress.Optout']!
        : report?.noNetwork ? REASONS['DestinationAddress.NoNetworkFound']!
        : report?.duplicates ? REASONS['DuplicateMessage']!
        : reasonFor(firstError?.errorCode, 'SMSPortal accepted the request but sent nothing.');
      return { status: 'REJECTED', reason };
    }

    switch (response.status) {
      case 400:
        return {
          status: 'REJECTED',
          reason: reasonFor(firstError?.errorCode, firstError?.errorMessage ? `SMSPortal refused it: ${firstError.errorMessage}` : 'SMSPortal refused the message.'),
          ...(firstError?.errorCode ? { code: firstError.errorCode } : {}),
        };
      case 401:
        console.error('[sms] SMSPortal refused the credentials (401)');
        return { status: 'REJECTED', reason: REASONS['InvalidCredentials']! };
      // Out of credits or the account switched off: fixable, and nothing
      // went, so worth trying again after the backoff.
      case 403:
        return { status: 'RETRY', reason: reasonFor(firstError?.errorCode, 'SMSPortal refused the account (out of credits or deactivated).') };
      case 429:
        return { status: 'RETRY', reason: 'SMSPortal asked us to slow down.' };
      case 503:
        return { status: 'RETRY', reason: 'SMSPortal is unavailable for a moment.' };
      default:
        // A 500 or a gateway error mid-call: it may have been accepted.
        return { status: 'UNKNOWN', reason: `SMSPortal answered with an error (${response.status}).` };
    }
  },
};
