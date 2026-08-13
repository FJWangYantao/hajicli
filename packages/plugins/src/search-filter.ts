export const DEFAULT_EXCLUDED_DIRS: readonly string[] = ['.git', '.haji', 'node_modules', 'dist', 'build', 'out', '.gemini'];
export const DEFAULT_EXCLUDED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz',
  '.mp3', '.mp4', '.wav', '.mov', '.exe', '.dll', '.bin', '.woff', '.woff2', '.ttf', '.eot'
]);
export const FILE_TYPE_GLOBS: Record<string, string[]> = {
  typescript: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
  javascript: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  python: ['**/*.py', '**/*.pyi'],
  java: ['**/*.java'],
  rust: ['**/*.rs'],
  go: ['**/*.go'],
  json: ['**/*.json', '**/*.jsonc'],
  markdown: ['**/*.md', '**/*.mdx'],
  yaml: ['**/*.yaml', '**/*.yml'],
  shell: ['**/*.sh', '**/*.bash', '**/*.zsh', '**/*.ps1'],
  html: ['**/*.html', '**/*.htm'],
  css: ['**/*.css', '**/*.scss', '**/*.sass', '**/*.less']
};

const MAX_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 256;

export interface PathFilterOptions {
  include: string[];
  exclude: string[];
  fileTypes: string[];
}

export function parseIntegerOption(
  value: unknown,
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return parsed;
}

export function parsePatternArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PATTERNS || value.some(item => (
    typeof item !== 'string' || !item.trim() || item.length > MAX_PATTERN_LENGTH
  ))) {
    throw new Error(`${name} 必须是最多 ${MAX_PATTERNS} 个字符串组成的数组，每项长度为 1-${MAX_PATTERN_LENGTH}。`);
  }
  return value.map(item => item.trim().replace(/\\/g, '/'));
}

export function parseFileTypes(value: unknown): string[] {
  const fileTypes = parsePatternArray(value, 'fileTypes').map(type => type.toLowerCase());
  const unsupportedTypes = fileTypes.filter(type => !FILE_TYPE_GLOBS[type]);
  if (unsupportedTypes.length > 0) {
    throw new Error(`不支持的文件类型：${unsupportedTypes.join(', ')}。可用类型：${Object.keys(FILE_TYPE_GLOBS).join(', ')}。`);
  }
  return fileTypes;
}

function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

/** Supports the portable glob subset shared by repository tools: *, ** and ?. */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/^\.\//, '').replace(/\\/g, '/');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  const prefix = normalized.includes('/') ? '^' : '(?:^|/)';
  return new RegExp(`${prefix}${source}$`);
}

function matchesAny(pathname: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(pathname));
}

export function createPathFilter(options: PathFilterOptions): (pathname: string) => boolean {
  const includePatterns = options.include.map(globToRegExp);
  const excludePatterns = options.exclude.map(globToRegExp);
  const typePatterns = options.fileTypes.flatMap(type => FILE_TYPE_GLOBS[type]).map(globToRegExp);
  return pathname => {
    const normalized = pathname.replace(/\\/g, '/');
    if (includePatterns.length > 0 && !matchesAny(normalized, includePatterns)) return false;
    if (typePatterns.length > 0 && !matchesAny(normalized, typePatterns)) return false;
    if (excludePatterns.length > 0 && matchesAny(normalized, excludePatterns)) return false;
    return true;
  };
}
