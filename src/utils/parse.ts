export interface ParsedTikzBlock {
  code: string;
  libraries?: string;
  packages?: Record<string, string>;
  preamble?: string;
}

export function parseTikzBlock(raw: string): ParsedTikzBlock {
  const lines = raw.split('\n');
  const parsed: ParsedTikzBlock = { code: '' };
  let codeStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('%%')) break;

    codeStart = i + 1;
    const m = line.match(/^%%\s*([\w-]+)\s*:\s*(.+)$/);
    if (!m) continue;

    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === 'libraries' || key === 'tikz-libraries') {
      parsed.libraries = value;
    } else if (key === 'preamble' || key === 'add-to-preamble') {
      parsed.preamble = value;
    } else if (key === 'packages' || key === 'tex-packages') {
      try {
        const json = JSON.parse(value);
        if (json && typeof json === 'object') {
          parsed.packages = json;
        }
      } catch {
        const names = value
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        parsed.packages = Object.fromEntries(names.map((n) => [n, '']));
      }
    }
  }

  parsed.code = lines.slice(codeStart).join('\n').trim();
  return parsed;
}

export function parseTikzBlocksFromMarkdown(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```tikz\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}
