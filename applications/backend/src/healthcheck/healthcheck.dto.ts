/** HTTP application liveness. Does not query external dependencies. */
export class HealthResponseDto {
  status!: 'ok';
  service!: 'gchat-backend';
}

export class DependencyChecksDto {
  database!: 'up' | 'down';
  redis!: 'up' | 'down';
}

/** Current dependency availability, without schema or persistence verification. */
export class ReadinessResponseDto {
  status!: 'ok' | 'error';
  service!: 'gchat-backend';
  checks!: DependencyChecksDto;
}
