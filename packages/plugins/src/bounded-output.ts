export interface BoundedRecordsResult {
  text: string;
  count: number;
  truncated: boolean;
}

/** Adds only complete records, so output limits never cut a path or source line in half. */
export function takeWholeRecords(
  records: readonly string[],
  maxLength: number,
  separator = '\n'
): BoundedRecordsResult {
  const accepted: string[] = [];
  let length = 0;
  for (const record of records) {
    const separatorLength = accepted.length > 0 ? separator.length : 0;
    if (length + separatorLength + record.length > maxLength) break;
    accepted.push(record);
    length += separatorLength + record.length;
  }
  return {
    text: accepted.join(separator),
    count: accepted.length,
    truncated: accepted.length < records.length
  };
}

export function truncateSingleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/[\r\n]+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
