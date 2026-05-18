export type LinkEntry = {
  title: string;
  description: string;
  image: string;
  target: string;
};

export type LinksMap = Record<string, LinkEntry>;

export const LINKS_SOURCE_URL =
  "https://raw.githubusercontent.com/dangtinh97/dangtinh97.github.io/refs/heads/master/shopee.json";
export const LINKS_REVALIDATE_SECONDS = 60;

export async function getLinks(): Promise<LinksMap> {
  const response = await fetch(LINKS_SOURCE_URL, {
    next: { revalidate: LINKS_REVALIDATE_SECONDS },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch links JSON: ${response.status}`);
  }

  return (await response.json()) as LinksMap;
}

export async function getLinkById(id: string): Promise<LinkEntry | null> {
  const links = await getLinks();

  return links[id] ?? null;
}

export async function getFirstLink(): Promise<LinkEntry | null> {
  const links = await getLinks();
  const firstKey = Object.keys(links)[0];

  if (!firstKey) {
    return null;
  }

  return links[firstKey] ?? null;
}

export async function getAllLinkIds(): Promise<string[]> {
  const links = await getLinks();

  return Object.keys(links);
}

export async function getRemoteLinks(url: string): Promise<LinksMap> {
  const response = await fetch(url, {
    next: { revalidate: LINKS_REVALIDATE_SECONDS },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch links JSON: ${response.status}`);
  }

  return (await response.json()) as LinksMap;
}
