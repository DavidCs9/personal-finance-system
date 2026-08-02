import { StatementImportSheet } from "./StatementImportSheet";
import type { SantanderStatementImportResult } from "../types";

export function SantanderStatementImportSheet({
  idToken,
  onClose,
  onApplied,
}: {
  idToken: string;
  onClose(): void;
  onApplied(result: SantanderStatementImportResult): void;
}) {
  return (
    <StatementImportSheet
      provider="santander"
      idToken={idToken}
      onClose={onClose}
      onApplied={onApplied}
    />
  );
}
