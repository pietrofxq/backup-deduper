/**
 * CSV helpers shared by the table primitive and per-page exporters.
 *
 * `csvEscape` does two things:
 *   1. RFC-style quote-and-escape for any field containing `,`, `"`, or a newline.
 *   2. Mitigates CSV formula injection — Excel/Sheets evaluate cells whose
 *      first character is `=`, `+`, `-`, `@`, `\t`, or `\r` as a formula. A
 *      malicious filename like `=cmd|'/c calc'!A1` could execute when the user
 *      opens an export. We're a backup-dedup tool walking arbitrary user data;
 *      the threat surface is real even if narrow. Prepend `'` to neutralize.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvEscape(s: string): string {
  const sanitized = FORMULA_LEAD.test(s) ? `'${s}` : s;
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

export function downloadCsv(filename: string, csvBody: string): void {
  const blob = new Blob([csvBody], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
