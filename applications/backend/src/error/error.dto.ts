export class ErrorFieldDto {
  field!: string;
  code!: string;
}

export class ErrorDetailDto {
  code!: string;
  message!: string;
  fields?: ErrorFieldDto[];
}

export class ErrorResponseDto {
  error!: ErrorDetailDto;
}
