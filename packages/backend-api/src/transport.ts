export type ApiResult<T> = {
  data: T;
  status: number;
  headers: Headers;
};

export type BackendApiOptions = {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly code?: string;
  readonly fields?: unknown;

  constructor(response: Response, body: unknown, cause?: unknown) {
    const detail = isRecord(body) && isRecord(body.error) ? body.error : undefined;

    super(typeof detail?.message === 'string' ? detail.message : `HTTP ${response.status}`, {
      cause,
    });
    this.name = 'ApiError';
    this.status = response.status;
    this.headers = response.headers;
    this.body = body;
    this.code = typeof detail?.code === 'string' ? detail.code : undefined;
    this.fields = detail?.fields;
  }
}

/** A successful HTTP response whose body could not be parsed. */
export class ApiResponseParseError extends Error {
  readonly status: number;
  readonly headers: Headers;

  constructor(response: Response, cause: unknown) {
    super('Cannot parse API response', { cause });
    this.name = 'ApiResponseParseError';
    this.status = response.status;
    this.headers = response.headers;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

type Parameter = {
  name: string;
  in: 'path' | 'query';
  style?: string;
  explode?: boolean;
};

type Operation = {
  path: string;
  method: string;
  protected: boolean;
  emptyResponses: readonly number[];
  parameters: readonly Parameter[];
};

export type RequestArguments = {
  path?: object;
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
};

export class ApiTransport {
  private readonly options: BackendApiOptions;

  constructor(options: BackendApiOptions) {
    if (!options?.baseUrl) {
      throw new TypeError('baseUrl is required');
    }

    this.options = { ...options };
  }

  async request<T>(operation: Operation, args: RequestArguments = {}): Promise<ApiResult<T>> {
    let path = operation.path;
    const query = new URLSearchParams();

    for (const parameter of operation.parameters) {
      const section = parameter.in === 'path' ? args.path : args.query;
      const value: unknown =
        section && Object.getOwnPropertyDescriptor(section, parameter.name)?.value;

      if (value === undefined) {
        continue;
      }

      if (parameter.in === 'path') {
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
      } else if (Array.isArray(value)) {
        if (parameter.explode !== false) {
          for (const entry of value) {
            query.append(parameter.name, String(entry));
          }
        } else {
          query.append(parameter.name, value.join(','));
        }
      } else {
        query.append(parameter.name, String(value));
      }
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}${query.size ? `?${query}` : ''}`;
    const headers = new Headers({ Accept: 'application/json' });

    if (args.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    if (operation.protected) {
      const token = await this.options.getAccessToken?.();

      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    }

    const fetch = this.options.fetch ?? globalThis.fetch;
    const response = await fetch(url, {
      method: operation.method.toUpperCase(),
      headers,
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: args.signal,
    });
    let data: T;

    try {
      // Response.json() is intentionally used without DTO runtime validation.
      const {
        status: responseStatus,
        ok: responseOk,
        headers: responseHeaders,
        json: responseJson,
        text: responseText,
      } = response;

      data =
        responseStatus === 204 || operation.emptyResponses.includes(responseStatus)
          ? undefined
          : await (responseOk ||
            /(?:application\/json|[+]json)(?:;|$)/i.test(responseHeaders.get('Content-Type') ?? '')
              ? responseJson.bind(response)()
              : responseText.bind(response)());
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) {
        throw cause;
      }

      const { ok: responseOk2 } = response ?? {};

      if (!responseOk2) {
        throw new ApiError(response, undefined, cause);
      }

      throw new ApiResponseParseError(response, cause);
    }

    const { ok: responseOk3 } = response ?? {};

    if (!responseOk3) {
      throw new ApiError(response, data);
    }

    const { status: responseStatus2, headers: responseHeaders2 } = response;

    return { data, status: responseStatus2, headers: responseHeaders2 };
  }
}
