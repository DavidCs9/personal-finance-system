import type { ReactNode } from "react";

export function Sheet({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-handle" />
        <header>
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
