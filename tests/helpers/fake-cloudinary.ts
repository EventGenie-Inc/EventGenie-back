// ─────────────────────────────────────────
//  FAKE CLOUDINARY — every request to api.cloudinary.com in the suite
//  lands here (installed by tests/setup.ts), so no test ever reaches a
//  real account, and a test that forgets to mock Cloudinary still can't.
//
//  It holds assets in memory, keyed by public id, and answers the calls
//  this app makes: explicit (measuring an upload), destroy (the storage
//  worker), the Admin API's batch delete and listing, and a private raw
//  upload (guest documents). A test puts what Cloudinary "holds" with
//  put(), makes calls fail with failDestroy / failExplicit, and reads what
//  was asked of it from `calls`. Reset before every test.
//
//  A test file that mocks cloudinary.client.js itself (vi.mock) keeps
//  doing so; this sits underneath, at fetch.
// ─────────────────────────────────────────

export interface FakeAsset {
  bytes: number;
  resourceType: 'image' | 'video' | 'raw';
  type: 'upload' | 'private';
  format: string;
  createdAt: string;
}

export interface FakeCall {
  method: string;
  endpoint: string; // 'explicit' | 'destroy' | 'upload' | 'delete_resources' | 'list'
  resourceType: string;
  publicIds: string[];
  params: Record<string, string>;
}

const API = 'https://api.cloudinary.com/';

export const fakeCloudinary = {
  assets: new Map<string, FakeAsset>(),
  calls: [] as FakeCall[],
  // Public ids whose destroy fails (500) until removed from the set.
  failDestroy: new Set<string>(),
  // Every explicit call fails with a 500 while true.
  failExplicit: false,
  // An upload is stored, then answered with a 500, as when a response is
  // lost after Cloudinary kept the file (a timeout).
  failUploadAfterStoring: false,

  put(publicId: string, asset: Partial<FakeAsset> & { bytes: number }): void {
    this.assets.set(publicId, {
      resourceType: 'image',
      type: 'upload',
      format: 'jpg',
      createdAt: new Date().toISOString(),
      ...asset,
    });
  },

  callsTo(endpoint: string): FakeCall[] {
    return this.calls.filter((c) => c.endpoint === endpoint);
  },

  destroyedIds(): string[] {
    return this.callsTo('destroy').map((c) => c.publicIds[0]!);
  },

  reset(): void {
    this.assets.clear();
    this.calls = [];
    this.failDestroy.clear();
    this.failExplicit = false;
    this.failUploadAfterStoring = false;
  },
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const formParams = async (init: RequestInit | undefined): Promise<Record<string, string>> => {
  const body = init?.body;
  if (!body) return {};
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  if (body instanceof FormData) {
    const out: Record<string, string> = {};
    for (const [k, v] of body.entries()) out[k] = typeof v === 'string' ? v : `<file:${(v as Blob).size}>`;
    return out;
  }
  if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body).entries());
  return {};
};

const handle = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
  // /v1_1/<cloud>/<rest...>
  const parts = url.pathname.split('/').filter(Boolean).slice(2);
  const method = (init?.method ?? 'GET').toUpperCase();
  const params = await formParams(init);

  // Admin API: /resources/<rt>/<type>
  if (parts[0] === 'resources') {
    const [, resourceType = 'image', type = 'upload'] = parts;
    if (method === 'DELETE') {
      const ids = url.searchParams.getAll('public_ids[]');
      fakeCloudinary.calls.push({ method, endpoint: 'delete_resources', resourceType, publicIds: ids, params: {} });
      const deleted: Record<string, string> = {};
      for (const id of ids) deleted[id] = fakeCloudinary.assets.delete(id) ? 'deleted' : 'not_found';
      return json(200, { deleted, partial: false });
    }
    const prefix = url.searchParams.get('prefix') ?? '';
    fakeCloudinary.calls.push({ method, endpoint: 'list', resourceType, publicIds: [], params: { prefix } });
    const matching = [...fakeCloudinary.assets.entries()]
      .filter(([id, a]) => id.startsWith(prefix) && a.resourceType === resourceType && a.type === type)
      .sort(([a], [b]) => a.localeCompare(b));
    const start = Number(url.searchParams.get('next_cursor') ?? 0);
    const max = Number(url.searchParams.get('max_results') ?? 10);
    const page = matching.slice(start, start + max);
    return json(200, {
      resources: page.map(([id, a]) => ({ public_id: id, bytes: a.bytes, created_at: a.createdAt, resource_type: a.resourceType, type: a.type })),
      ...(start + max < matching.length ? { next_cursor: String(start + max) } : {}),
    });
  }

  // Upload API: /<rt>/<action>
  const [resourceType = 'image', action = ''] = parts;
  const publicId = params['public_id'] ?? '';
  fakeCloudinary.calls.push({ method, endpoint: action, resourceType, publicIds: [publicId], params });

  if (action === 'explicit') {
    if (fakeCloudinary.failExplicit) return json(500, { error: { message: 'fake explicit failure' } });
    const asset = fakeCloudinary.assets.get(publicId);
    if (!asset || asset.resourceType !== resourceType) return json(404, { error: { message: 'Resource not found' } });
    return json(200, {
      public_id: publicId,
      bytes: asset.bytes,
      format: asset.format,
      resource_type: asset.resourceType,
      secure_url: `https://res.cloudinary.com/fake/${asset.resourceType}/upload/${publicId}.${asset.format}`,
    });
  }
  if (action === 'destroy') {
    if (fakeCloudinary.failDestroy.has(publicId)) return json(500, { error: { message: 'fake destroy failure' } });
    return json(200, { result: fakeCloudinary.assets.delete(publicId) ? 'ok' : 'not found' });
  }
  if (action === 'upload') {
    const size = Number((params['file'] ?? '').match(/<file:(\d+)>/)?.[1] ?? 0);
    fakeCloudinary.put(publicId, { bytes: size, resourceType: resourceType as FakeAsset['resourceType'], type: (params['type'] as FakeAsset['type']) ?? 'upload', format: 'raw' });
    if (fakeCloudinary.failUploadAfterStoring) return json(500, { error: { message: 'fake: stored, then the response was lost' } });
    return json(200, { public_id: publicId, bytes: size });
  }
  return json(400, { error: { message: `fake Cloudinary doesn't know ${action}` } });
};

// Wraps fetch once per test file: Cloudinary's API goes to the fake,
// everything else to the real fetch.
export const installFakeCloudinary = (): void => {
  const realFetch = globalThis.fetch;
  if ((realFetch as { __fakeCloudinary?: boolean }).__fakeCloudinary) return;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href.startsWith(API)) return handle(url, init);
    return realFetch(input, init);
  }) as typeof fetch & { __fakeCloudinary?: boolean };
  wrapped.__fakeCloudinary = true;
  globalThis.fetch = wrapped;
};
