import type { EventFeed } from "../types";
import { mockEventFeed } from "./mock-data";

/**
 * The only data boundary used by the UI. Replace the mock implementation with
 * fetch calls once API Gateway and Cognito are available.
 */
export interface LedgerApi {
  listEvents(): Promise<EventFeed>;
}

const mockApi: LedgerApi = {
  async listEvents() {
    return mockEventFeed;
  },
};

export const ledgerApi: LedgerApi = mockApi;
