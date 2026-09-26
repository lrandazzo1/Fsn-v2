/**
 * csv.ts
 * -----------------------------------------------------------------------------
 * An RFC 4180 CSV reader, because the reference data this project reconciles
 * against ships as CSV and the project has no runtime dependencies.
 *
 * Quoting is not optional here: nflverse's own columns contain the delimiter —
 * `college_name` holds "Oklahoma; Texas A&M" and every headshot URL contains
 * `f_auto,q_auto` — so a `split(',')` mis-shifts every field after the first
 * quoted one and files players under the wrong team. Escaped quotes (`""`),
 * CRLF line endings, a UTF-8 BOM and a quoted embedded newline are all handled.
 */

/** Splits CSV text into rows of raw cells. Blank trailing lines are dropped. */
export function parseCsvRows(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = (): void => {
    endField();
    // A trailing newline produces one empty cell — not a row.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !started) {
      quoted = true;
      started = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      field += char;
      started = true;
    }
  }

  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Parses CSV into objects keyed by the header row. Duplicate header names keep
 * the first column, short rows read as empty strings — a reference feed that
 * grows a column must not break a reader that does not know about it yet.
 */
export function parseCsv(input: string): Array<Record<string, string>> {
  const rows = parseCsvRows(input);
  if (rows.length === 0) return [];

  const header = rows[0].map((name) => name.trim());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      const key = header[c];
      if (!key || Object.hasOwn(record, key)) continue;
      record[key] = cells[c] ?? '';
    }
    out.push(record);
  }
  return out;
}
