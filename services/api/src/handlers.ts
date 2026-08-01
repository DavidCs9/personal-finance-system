import { isInstitution } from "@finance/domain";
import type { Institution } from "@finance/domain";
import type { FinanceApiService } from "./service.js";

export interface HttpRequest {
  readonly pathParameters?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>>;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const json = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

const plainText = (statusCode: number, body: string): HttpResponse => ({
  statusCode,
  headers: { "content-type": "message/rfc822; charset=utf-8" },
  body,
});

const idFrom = (request: HttpRequest): string | undefined => request.pathParameters?.id;

/** Framework-neutral handler factory; a thin Lambda adapter can call these functions. */
export const createHandlers = (service: FinanceApiService) => ({
  feed: async (request: HttpRequest): Promise<HttpResponse> => {
    const query = request.queryStringParameters ?? {};
    let institution: Institution | undefined;
    if (query.institution !== undefined) {
      if (!isInstitution(query.institution)) {
        return json(400, { message: "Unknown institution filter." });
      }
      institution = query.institution;
    }
    return json(
      200,
      await service.feed({
        institution,
        accountId: query.accountId,
        from: query.from,
        to: query.to,
      }),
    );
  },

  detail: async (request: HttpRequest): Promise<HttpResponse> => {
    const id = idFrom(request);
    if (!id) return json(400, { message: "An event id is required." });
    const detail = await service.detail(id);
    return detail ? json(200, detail) : json(404, { message: "Event not found." });
  },

  raw: async (request: HttpRequest): Promise<HttpResponse> => {
    const id = idFrom(request);
    if (!id) return json(400, { message: "An event id is required." });
    const raw = await service.raw(id);
    return raw === undefined ? json(404, { message: "Event not found." }) : plainText(200, raw);
  },

  revisions: async (request: HttpRequest): Promise<HttpResponse> => {
    const id = idFrom(request);
    if (!id) return json(400, { message: "An event id is required." });
    const revisions = await service.revisions(id);
    return revisions === undefined ? json(404, { message: "Event not found." }) : json(200, revisions);
  },
});
