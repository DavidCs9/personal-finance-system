import { StatementImportSheet } from "./StatementImportSheet";
import type { AmexImportResult } from "../types";

export function AmexImportSheet({
  idToken,
  onClose,
  onApplied,
}: {
  idToken: string;
  onClose(): void;
  onApplied(result: AmexImportResult): void;
}) {
  return (
    <StatementImportSheet
      provider="amex"
      idToken={idToken}
      onClose={onClose}
      onApplied={onApplied}
    />
  );
}
