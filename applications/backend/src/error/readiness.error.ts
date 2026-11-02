import { ServiceUnavailableException } from '@nestjs/common';

export interface ReadinessResponse {
  status: string;
  service: string;
  checks: { database: string; redis: string };
}

/** Explicit exception for the established healthcheck response contract. */
export class ReadinessError extends ServiceUnavailableException {
  constructor(readonly readiness: ReadinessResponse) {
    super(readiness);
  }
}
