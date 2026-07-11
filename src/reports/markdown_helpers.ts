export function clean(value: unknown): string {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function table(headers: string[], rows: unknown[][]): string[] {
  return [
    `| ${headers.map(clean).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(clean).join(' | ')} |`),
  ];
}

export function link(label: string, url: string | null): string {
  return url ? `[${clean(label)}](${url})` : clean(label);
}
