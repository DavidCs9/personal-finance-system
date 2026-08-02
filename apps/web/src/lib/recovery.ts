import type { IngestionException } from "../types";

export const recoveryMessage = (exception: IngestionException): string => {
  if (exception.reason === "unsupported_source") {
    return "No reconocimos el origen o formato. Revisa el correo antes de decidir.";
  }
  if (exception.reason === "parser_failed") {
    return "Reconocimos el origen, pero faltaron datos para crear el movimiento.";
  }
  if (exception.reason === "missing_required_data") {
    return "El correo no contiene todos los datos necesarios.";
  }
  return "Este correo necesita revisión antes de convertirse en movimiento.";
};
