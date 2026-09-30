export class PretixApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`pretix API error ${status}: ${JSON.stringify(body)}`);
  }
}

export interface PretixConfig {
  baseUrl: string;
  token: string;
  organizer: string;
  event?: string;
}

export function loadConfigFromEnv(): PretixConfig {
  const baseUrl = process.env.PRETIX_BASE_URL;
  const token = process.env.PRETIX_API_TOKEN;
  const organizer = process.env.PRETIX_ORGANIZER;
  const event = process.env.PRETIX_EVENT;

  if (!baseUrl) throw new Error("PRETIX_BASE_URL is not set");
  if (!token) throw new Error("PRETIX_API_TOKEN is not set");
  if (!organizer) throw new Error("PRETIX_ORGANIZER is not set");

  return { baseUrl: baseUrl.replace(/\/+$/, ""), token, organizer, event };
}

export class PretixClient {
  constructor(private config: PretixConfig) {}

  private url(path: string): string {
    return `${this.config.baseUrl}/api/v1${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: {
        Authorization: `Token ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;

    if (!res.ok) {
      throw new PretixApiError(res.status, data);
    }
    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body ?? {});
  }

  /** organizer slug, defaulting to the configured PRETIX_ORGANIZER */
  organizer(override?: string): string {
    return override ?? this.config.organizer;
  }

  /** event slug, defaulting to the configured PRETIX_EVENT if set */
  event(override?: string): string {
    const slug = override ?? this.config.event;
    if (!slug) {
      throw new Error(
        "No event slug given and PRETIX_EVENT is not set as a default",
      );
    }
    return slug;
  }
}
