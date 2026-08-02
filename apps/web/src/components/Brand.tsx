export function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <i />
    </span>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <Mark />
      <span>Olbia</span>
    </div>
  );
}
