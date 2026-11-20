import type { ReactNode } from "react";

/**
 * The message under a form field. The field points at it with `aria-describedby={id}` and sets `aria-invalid`.
 * It is announced when it first appears; keep it mounted for one error and clear it when the person edits the field.
 * Nothing renders for an empty or whitespace-only message, so a blank alert is never announced.
 */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  const empty = children == null || children === false || (typeof children === "string" && !children.trim());
  if (empty) return null;
  return <p id={id} role="alert" className="mt-1 text-sm text-stellar-danger-text">{children}</p>;
}
