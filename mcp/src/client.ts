import { request as httpRequest } from "node:http";

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
  // Set when talking to pretix over an internal address (see loadConfigFromEnv):
  // pretix rejects requests whose Host is not its configured public URL.
  hostHeader?: string;
  forwardedProto?: string;
}

export function loadConfigFromEnv(): PretixConfig {
  const explicitBaseUrl = process.env.PRETIX_BASE_URL;
  const token = process.env.PRETIX_API_TOKEN;
  const organizer = process.env.PRETIX_ORGANIZER;
  const event = process.env.PRETIX_EVENT;

  const publicUrl = process.env.PRETIX_PRETIX_URL;
  if (!explicitBaseUrl && !publicUrl) throw new Error("PRETIX_BASE_URL is not set");
  if (!token) throw new Error("PRETIX_API_TOKEN is not set");
  if (!organizer) throw new Error("PRETIX_ORGANIZER is not set");

  if (explicitBaseUrl) {
    return { baseUrl: explicitBaseUrl.replace(/\/+$/, ""), token, organizer, event };
  }

  // Running inside the pretix container (PRETIX_PRETIX_URL is pretix's own
  // config): call pretix locally instead of through the public URL, but
  // present the public host so its host check passes.
  const pub = new URL(publicUrl!);
  return {
    baseUrl: (process.env.PRETIX_INTERNAL_URL ?? "http://127.0.0.1:8345").replace(/\/+$/, ""),
    token,
    organizer,
    event,
    hostHeader: pub.host,
    forwardedProto: pub.protocol.replace(":", ""),
  };
}

interface SimpleResponse {
  ok: boolean;
  status: number;
  text: string;
}

async function fetchAsSimpleResponse(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<SimpleResponse> {
  const res = await fetch(url, { method, headers, body });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

// Node's fetch silently ignores a custom Host header, which pretix needs when
// this runs inside its container (see loadConfigFromEnv), so use node:http.
function requestWithHostHeader(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, text });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export class PretixClient {
  constructor(private config: PretixConfig) {}

  private url(path: string): string {
    return `${this.config.baseUrl}/api/v1${path}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Token ${this.config.token}`,
      "Content-Type": "application/json",
      ...(this.config.forwardedProto ? { "X-Forwarded-Proto": this.config.forwardedProto } : {}),
    };
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const res = this.config.hostHeader
      ? await requestWithHostHeader(this.url(path), method, { ...headers, Host: this.config.hostHeader }, payload)
      : await fetchAsSimpleResponse(this.url(path), method, headers, payload);

    const data = res.text ? JSON.parse(res.text) : undefined;

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

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
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
