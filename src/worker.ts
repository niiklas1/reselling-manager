interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

function jsonResponse(value: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function isValidGtin(value: string): boolean {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(value)) return false
  const body = value.slice(0, -1)
  let sum = 0
  let weight = 3
  for (let index = body.length - 1; index >= 0; index--) {
    sum += Number(body[index]) * weight
    weight = weight === 3 ? 1 : 3
  }
  return (10 - (sum % 10)) % 10 === Number(value.at(-1))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    if (origin && origin !== url.origin) return jsonResponse({ error: 'Origin not allowed' }, 403)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Origin': url.origin } })
    }

    if (url.pathname === '/api/product/lookup' && request.method === 'GET') {
      const barcodes = (url.searchParams.get('barcodes') || '').split(',').map(value => value.trim()).filter(Boolean)
      if (!barcodes.length || barcodes.length > 2 || barcodes.some(code => !isValidGtin(code))) {
        return jsonResponse({ error: 'Only one or two checksum-valid EAN/UPC/GTIN codes are accepted.' }, 400)
      }
      const upstreamUrl = new URL('https://api.upcitemdb.com/prod/trial/lookup')
      upstreamUrl.searchParams.set('upc', barcodes.join(','))
      try {
        const upstream = await fetch(upstreamUrl, { headers: { Accept: 'application/json' } })
        const headers = new Headers(upstream.headers)
        headers.set('Content-Type', 'application/json; charset=utf-8')
        headers.set('Cache-Control', upstream.ok ? 'public, max-age=86400' : 'no-store')
        headers.set('X-Content-Type-Options', 'nosniff')
        return new Response(upstream.body, { status: upstream.status, headers })
      } catch {
        return jsonResponse({ error: 'Product catalog temporarily unavailable' }, 502)
      }
    }

    if (url.pathname === '/api/product/search' && request.method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 100)
      if (query.length < 5) return jsonResponse({ error: 'Search query is too short' }, 400)
      try {
        const upstream = await fetch('https://api.upcitemdb.com/prod/trial/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ s: query, type: 'product', match_mode: 0 }),
        })
        const headers = new Headers(upstream.headers)
        headers.set('Content-Type', 'application/json; charset=utf-8')
        headers.set('Cache-Control', upstream.ok ? 'public, max-age=86400' : 'no-store')
        headers.set('X-Content-Type-Options', 'nosniff')
        return new Response(upstream.body, { status: upstream.status, headers })
      } catch {
        return jsonResponse({ error: 'Product search temporarily unavailable' }, 502)
      }
    }

    return env.ASSETS.fetch(request)
  },
}
