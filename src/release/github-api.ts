// A small read-only GitHub REST client for the release scripts: every page of
// a list, a token sent only to the API it was given for, and one error type
// for anything that cannot be read.

export class ReadError extends Error {}

export type Json = Record<string, unknown>;

// The fields of an API object; anything else reads as an object without fields.
export function fields(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function nextPage(link: string | null): string | undefined {
  for (const part of (link ?? '').split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

export function client(apiUrl: string, defaultToken: string, userAgent: string) {
  const origin = new URL(apiUrl).origin;
  const base = apiUrl.replace(/\/+$/, '');

  async function request(url: string, what: string, token: string): Promise<Response> {
    // A token is only ever sent to the API it was given for, even when a page link points elsewhere.
    if (URL.parse(url)?.origin !== origin) throw new ReadError(`Cannot read ${what}: the API answered with a link outside ${origin}`);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
    }).catch((error: unknown) => {
      throw new ReadError(`Cannot read ${what}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!response.ok) {
      const message = fields(await response.json().catch(() => ({}))).message;
      throw new ReadError(`Cannot read ${what}: HTTP ${response.status}${typeof message === 'string' ? ` ${message}` : ''}`);
    }
    return response;
  }

  async function body(response: Response, what: string): Promise<unknown> {
    return response.json().catch(() => {
      throw new ReadError(`Cannot read ${what}: the API did not return JSON`);
    });
  }

  return {
    async get(path: string, what: string, token = defaultToken): Promise<unknown> {
      return body(await request(`${base}${path}`, what, token), what);
    },
    // Every page of a list, so a blocking item on a later page is never missed.
    async list(path: string, what: string, token = defaultToken): Promise<Json[]> {
      const items: Json[] = [];
      for (let url: string | undefined = `${base}${path}`; url !== undefined;) {
        const response = await request(url, what, token);
        const page = await body(response, what);
        if (!Array.isArray(page)) throw new ReadError(`Cannot read ${what}: the API did not return a list`);
        items.push(...page.map(fields));
        url = nextPage(response.headers.get('link'));
      }
      return items;
    },
  };
}

export type Client = ReturnType<typeof client>;
