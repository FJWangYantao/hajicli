import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PREFERENCES_PATH = path.join(process.cwd(), '.haji', 'preferences.json');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Preferences {
  model: string;
  reasoningEffort: string;
  permissionMode?: string;
  riskThreshold?: string;
}

export function loadPreference(preferencePath = DEFAULT_PREFERENCES_PATH): Preferences | null {
  try {
    return JSON.parse(fs.readFileSync(preferencePath, 'utf8')) as Preferences;
  } catch {
    return null;
  }
}

export function savePreference(
  preference: Preferences,
  onWarning?: (message: string) => void,
  preferencePath = DEFAULT_PREFERENCES_PATH
): boolean {
  try {
    fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
    fs.writeFileSync(preferencePath, JSON.stringify(preference, null, 2), 'utf8');
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onWarning?.(`用户偏好保存失败：${detail}`);
    return false;
  }
}

export function formatToolArgs(args: Record<string, unknown>, maxLength = 45): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const formatted = keys.map(key => {
    const value = typeof args[key] === 'string' ? args[key] : JSON.stringify(args[key]);
    return `${key}: "${String(value).replace(/\r?\n/g, ' ')}"`;
  }).join(', ');
  return formatted.length > maxLength
    ? `${formatted.slice(0, maxLength - 3)}...`
    : formatted;
}

export function getCliVersion(): string {
  try {
    const packagePath = path.join(__dirname, '..', 'package.json');
    const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };
    return packageData.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}
