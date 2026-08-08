import type { ReactNode } from "react";

export function Sheet({
  title,
  eyebrow,
  onClose,
  children,
  className,
  closeLabel = "Cerrar",
  closeIcon = "×",
}: {
  title: string;
  eyebrow: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  closeIcon?: ReactNode;
}) {
  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className={["sheet", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sheet-handle" />
        <header>
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label={closeLabel}>
            {closeIcon}
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
