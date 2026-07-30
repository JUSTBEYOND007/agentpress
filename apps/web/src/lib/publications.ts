export type PublicArticleDto = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly editionNumber: number;
  readonly publishedAt: string;
  readonly coverAssetId: string | null;
  readonly coverAttribution: string | null;
  readonly score: number;
  readonly upvotes: number;
  readonly downvotes: number;
  readonly views: number;
};

const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4000';
const publicApiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? apiOrigin;

export async function fetchTrending(): Promise<readonly PublicArticleDto[]> {
  const response = await fetch(`${apiOrigin}/v1/trending?limit=20`, {
    next: { revalidate: 60, tags: ['trending'] },
  });
  if (!response.ok) throw new Error(`Trending API failed with ${String(response.status)}`);
  return (await response.json()) as readonly PublicArticleDto[];
}

export async function fetchPublication(slug: string): Promise<PublicArticleDto | undefined> {
  const response = await fetch(`${apiOrigin}/v1/publications/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Publication API failed with ${String(response.status)}`);
  return (await response.json()) as PublicArticleDto;
}

export function mediaUrl(assetId: string): string {
  return `${publicApiOrigin}/v1/media/${encodeURIComponent(assetId)}/content`;
}
