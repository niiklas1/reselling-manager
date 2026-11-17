export type ProductImageResult = {
  id: string
  title: string
  thumbnail: string
  url: string
  landingUrl: string
  creator: string
  license: string
}

export function googleImagesUrl(query: string): string {
  return 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(query.trim())
}

/**
 * Openverse returns relevance-ranked images that are licensed for commercial
 * reuse. The first result is selected automatically; alternatives are only
 * shown after the user asks to change the image.
 */
export async function searchProductImages(query: string): Promise<ProductImageResult[]> {
  const cleanQuery = query.trim()
  if (!cleanQuery) return []
  const endpoint = 'https://api.openverse.org/v1/images/?q=' +
    encodeURIComponent(cleanQuery) + '&page_size=8&license_type=commercial'
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('Die automatische Bildsuche ist momentan nicht erreichbar.')
  const data = await response.json() as { results?: Array<Record<string, unknown>> }
  return (data.results || [])
    .filter(item => typeof item.thumbnail === 'string' && typeof item.url === 'string')
    .map(item => ({
      id: String(item.id || item.url),
      title: String(item.title || cleanQuery),
      thumbnail: String(item.thumbnail),
      url: String(item.url),
      landingUrl: String(item.foreign_landing_url || item.url),
      creator: String(item.creator || ''),
      license: String(item.license || 'Unbekannt'),
    }))
    .slice(0, 8)
}
