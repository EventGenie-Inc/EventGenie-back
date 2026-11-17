import { describe, it, expect, afterEach, vi } from 'vitest';
import { smsPortalProvider, SMSPORTAL_SEND_URL } from '../../src/shared/messaging/smsportal.provider.js';
import { getSmsProvider, setSmsProviderForTests, assertSmsProviderConfigValid, NOT_CONFIGURED_REASON } from '../../src/shared/messaging/sms-provider.js';

// ─────────────────────────────────────────
//  THE SMSPORTAL PROVIDER — the request it makes (fetch is stubbed: no test
//  reaches SMSPortal) and how it reads each answer. TEST MODE: testMode is
//  true unless SMSPORTAL_TEST_MODE is exactly "false", so development and
//  tests never deliver a text or spend a credit by accident.
// ─────────────────────────────────────────

const SMS = { to: '+27825550501', body: 'Thandi invites you to Party: https://e-velope.co.za/rsvp?token=x', reference: 'item-1' };

const accepted = { statusCode: 200, sendResponse: { eventId: 123456, messages: 1, parts: 1, cost: 0.25, remainingBalance: 99, errorReport: { faults: [] } } };

const stubFetch = (status: number, body: unknown) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const requestBody = (fetchMock: ReturnType<typeof stubFetch>) => {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const withCredentials = () => {
  vi.stubEnv('SMSPORTAL_CLIENT_ID', 'client-id');
  vi.stubEnv('SMSPORTAL_API_SECRET', 'api-secret');
};

describe('test mode', () => {
  it('test mode never delivers: testMode is sent as true unless SMSPORTAL_TEST_MODE is exactly "false"', async () => {
    withCredentials();
    for (const value of ['true', '', 'TRUE', 'yes', 'False ', undefined]) {
      if (value === undefined) delete process.env.SMSPORTAL_TEST_MODE;
      else vi.stubEnv('SMSPORTAL_TEST_MODE', value);
      const fetchMock = stubFetch(200, accepted);
      const outcome = await smsPortalProvider.send(SMS);
      const expectReal = value?.trim().toLowerCase() === 'false';
      expect(requestBody(fetchMock).sendOptions.testMode, `SMSPORTAL_TEST_MODE=${String(value)}`).toBe(!expectReal);
      expect(outcome).toMatchObject({ status: 'ACCEPTED', testMode: !expectReal });
    }
    vi.stubEnv('SMSPORTAL_TEST_MODE', 'false');
    const real = stubFetch(200, accepted);
    await smsPortalProvider.send(SMS);
    expect(requestBody(real).sendOptions.testMode).toBe(false);
  });
});

describe('the request', () => {
  it('POSTs one message to /v3/BulkMessages with Basic auth and our reference', async () => {
    withCredentials();
    const fetchMock = stubFetch(200, accepted);
    expect(await smsPortalProvider.send(SMS)).toEqual({ status: 'ACCEPTED', providerMessageId: '123456', parts: 1, testMode: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SMSPORTAL_SEND_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from('client-id:api-secret').toString('base64')}`);
    expect(requestBody(fetchMock)).toEqual({
      messages: [{ destination: '27825550501', content: SMS.body, customerId: 'item-1' }],
      sendOptions: { testMode: true, allowContentTrimming: false },
    });
  });

  it('without credentials nothing is called', async () => {
    vi.stubEnv('SMSPORTAL_CLIENT_ID', '');
    const fetchMock = stubFetch(200, accepted);
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'REJECTED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reading the answer', () => {
  it('maps each answer to what the worker does', async () => {
    withCredentials();
    stubFetch(400, { errors: [{ errorCode: 'DestinationAddress.Invalid', errorMessage: 'bad' }] });
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'REJECTED', code: 'DestinationAddress.Invalid' });
    stubFetch(403, { errors: [{ errorCode: 'InsufficientCredits' }] });
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'RETRY', reason: 'The SMSPortal account is out of credits.' });
    stubFetch(429, {});
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'RETRY' });
    stubFetch(503, {});
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'RETRY' });
    stubFetch(500, {});
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'UNKNOWN' });
    stubFetch(200, { sendResponse: { messages: 0, parts: 0, errorReport: { optedOuts: 1, faults: [] } } });
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'REJECTED', reason: 'This number has opted out of text messages.' });
    stubFetch(200, { sendResponse: { eventId: 1, messages: 1, parts: 3 } });
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'ACCEPTED', parts: 3 });
  });

  it('a timeout is UNKNOWN (it may have gone); a refused connection is RETRY', async () => {
    withCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }));
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'UNKNOWN' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }));
    expect(await smsPortalProvider.send(SMS)).toMatchObject({ status: 'RETRY' });
  });
});

describe('choosing the provider', () => {
  it('SMS_PROVIDER picks SMSPortal; unset sends nothing; anything else stops the app', async () => {
    setSmsProviderForTests(null);
    vi.stubEnv('SMS_PROVIDER', 'smsportal');
    expect(getSmsProvider().name).toBe('smsportal');
    vi.stubEnv('SMS_PROVIDER', '');
    expect(await getSmsProvider().send(SMS)).toEqual({ status: 'REJECTED', reason: NOT_CONFIGURED_REASON });
    vi.stubEnv('SMS_PROVIDER', 'twilio');
    expect(() => assertSmsProviderConfigValid()).toThrow(/isn't a known SMS provider/);
    vi.stubEnv('SMS_PROVIDER', 'smsportal');
    expect(() => assertSmsProviderConfigValid()).not.toThrow();
  });
});
