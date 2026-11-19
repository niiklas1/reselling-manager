import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import ebayWorker from '../src/worker.ts'

const userId = '7a36c4cb-f0dc-4f4a-8d73-6e5e52d1c4ae'

function makeEnv() {
  return {
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    AI: { run: async () => ({}) },
    SUPABASE_URL: 'https://supabase.example.test',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key',
    SUPABASE_SECRET_KEY: 'sb_secret_test_key',
    EBAY_CLIENT_ID: 'ebay-client-id',
    EBAY_CLIENT_SECRET: 'ebay-client-secret',
    EBAY_RU_NAME: 'test-ebay-runame',
    EBAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    EBAY_DELETION_VERIFICATION_TOKEN: 'reselling-manager-test-verification-token-123456',
  }
}

test('eBay connect rejects requests without a signed-in Reselling Manager user', async () => {
  const previousFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    throw new Error('Unauthenticated requests must not reach Supabase or eBay')
  }

  try {
    const response = await ebayWorker.fetch(new Request('https://app.example.test/api/ebay/connect', {
      method: 'POST',
      headers: { Origin: 'https://app.example.test' },
    }), makeEnv())

    assert.equal(response.status, 401)
    assert.equal(fetchCalled, false)
    assert.deepEqual(await response.json(), {
      error: 'Bitte melde dich im Reselling Manager erneut an.',
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('eBay connect stores only a hashed one-time OAuth state and returns the eBay consent URL', async () => {
  const previousFetch = globalThis.fetch
  let storedState = null
  const env = makeEnv()
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/auth/v1/user') {
      assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_PUBLISHABLE_KEY)
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer a-valid-user-session-token')
      return Response.json({ id: userId })
    }
    if (url.pathname === '/rest/v1/ebay_oauth_states') {
      assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_SECRET_KEY)
      assert.equal(new Headers(init.headers).has('Authorization'), false)
      storedState = JSON.parse(String(init.body))
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected request: ' + url.toString())
  }

  try {
    const response = await ebayWorker.fetch(new Request('https://app.example.test/api/ebay/connect', {
      method: 'POST',
      headers: {
        Origin: 'https://app.example.test',
        Authorization: 'Bearer a-valid-user-session-token',
      },
    }), env)

    assert.equal(response.status, 200)
    const payload = await response.json()
    const authorizationUrl = new URL(payload.authorizationUrl)
    const state = authorizationUrl.searchParams.get('state')

    assert.equal(authorizationUrl.origin, 'https://auth.ebay.com')
    assert.equal(authorizationUrl.pathname, '/oauth2/authorize')
    assert.equal(authorizationUrl.searchParams.get('client_id'), env.EBAY_CLIENT_ID)
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), env.EBAY_RU_NAME)
    assert.equal(authorizationUrl.searchParams.get('response_type'), 'code')
    assert.equal(authorizationUrl.searchParams.has('client_secret'), false)
    assert.match(state || '', /^[A-Za-z0-9_-]{40,}$/)

    const requestedScopes = (authorizationUrl.searchParams.get('scope') || '').split(' ')
    assert.deepEqual(requestedScopes, [
      'https://api.ebay.com/oauth/api_scope/sell.listing.read',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
      'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
    ])

    assert.equal(storedState.user_id, userId)
    assert.equal(storedState.state_hash, createHash('sha256').update(state).digest('hex'))
    assert.notEqual(storedState.state_hash, state)
    assert.ok(Date.parse(storedState.expires_at) > Date.now())
    assert.equal(Object.hasOwn(storedState, 'refresh_token'), false)
  } finally {
    globalThis.fetch = previousFetch
  }
})


test('eBay deletion endpoint answers the challenge using the configured token and canonical URL', async () => {
  const env = makeEnv()
  const challengeCode = 'challenge-code-from-ebay'
  const endpoint = 'https://reselling-manager.j6c2njff5r.workers.dev/api/ebay/deletion'
  const response = await ebayWorker.fetch(new Request(endpoint + '?challenge_code=' + encodeURIComponent(challengeCode)), env)

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /application\\/json/i)
  const payload = await response.json()
  const expected = createHash('sha256')
    .update(challengeCode + env.EBAY_DELETION_VERIFICATION_TOKEN + endpoint)
    .digest('hex')
  assert.equal(payload.challengeResponse, expected)
})

test('eBay deletion notifications require a valid signature and delete only matching eBay records', async () => {
  const previousFetch = globalThis.fetch
  const env = makeEnv()
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const payload = {
    metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0', deprecated: false },
    notification: {
      notificationId: 'notification-id',
      eventDate: '2026-11-19T12:00:00.000Z',
      publishDate: '2026-11-19T12:00:01.000Z',
      publishAttemptCount: 1,
      data: { userId: 'immutable-ebay-user-id' },
    },
  }
  const signer = createSign('RSA-SHA1')
  signer.update(JSON.stringify(payload))
  signer.end()
  const envelope = {
    kid: 'unit-test-key-id',
    signature: signer.sign(privateKey, 'base64'),
  }
  const signatureHeader = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
  const deletedTables = []

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/identity/v1/oauth2/token') {
      return Response.json({ access_token: 'test-application-token', expires_in: 7200 })
    }
    if (url.pathname === '/commerce/notification/v1/public_key/unit-test-key-id') {
      return Response.json({ key: publicKey })
    }
    if (url.pathname === '/rest/v1/ebay_connections' && url.searchParams.has('ebay_user_id')) {
      assert.equal(url.searchParams.get('ebay_user_id'), 'eq.immutable-ebay-user-id')
      return Response.json([{ user_id: userId }])
    }
    if (url.pathname.startsWith('/rest/v1/ebay_') && init.method === 'DELETE') {
      assert.equal(new Headers(init.headers).get('apikey'), env.SUPABASE_SECRET_KEY)
      deletedTables.push(url.pathname.split('/').pop())
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected request: ' + url.toString())
  }

  try {
    const response = await ebayWorker.fetch(new Request('https://reselling-manager.j6c2njff5r.workers.dev/api/ebay/deletion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ebay-signature': signatureHeader,
      },
      body: JSON.stringify(payload),
    }), env)

    assert.equal(response.status, 204)
    assert.deepEqual(deletedTables.sort(), ['ebay_connections', 'ebay_listings', 'ebay_orders'])
  } finally {
    globalThis.fetch = previousFetch
  }
})
