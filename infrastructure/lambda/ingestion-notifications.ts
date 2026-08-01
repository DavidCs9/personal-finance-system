export interface IngestionExceptionAlertInput {
  readonly id: string;
  readonly receivedAt: string;
  readonly institution?: string;
  readonly reason: string;
  readonly details: string;
  readonly source: {
    readonly bucket: string;
    readonly key: string;
  };
}

export interface EmailAlert {
  readonly subject: string;
  readonly body: string;
}

export const ingestionExceptionAlert = (exception: IngestionExceptionAlertInput): EmailAlert => ({
  subject: `Movimiento requiere revisión: ${exception.institution ?? "origen desconocido"}`,
  body: [
    "Un correo financiero llegó al sistema, pero no pudo convertirse en un movimiento.",
    "",
    `Motivo: ${exception.reason}`,
    `Detalle: ${exception.details}`,
    `Institución: ${exception.institution ?? "no identificada"}`,
    `Recibido: ${exception.receivedAt}`,
    `ID de excepción: ${exception.id}`,
    `Fuente conservada: s3://${exception.source.bucket}/${exception.source.key}`,
    "",
    "El correo original permanece cifrado en S3 para revisión.",
  ].join("\n"),
});
