export function ConnectionScope({ note }: { note?: string }) {
  return note ? <p className="ms-check-scope">{note}</p> : null;
}
