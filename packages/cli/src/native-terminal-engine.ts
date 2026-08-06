import { createRequire } from 'node:module';

export interface NativeWrappedAnsiResult {
  rows: string[];
  activeStyle: string;
}

export interface NativeAnsiLayoutRow {
  ansi: string;
  plain: string;
  startOffset: number;
  endOffset: number;
}

export interface NativeAnsiTextLayout {
  rows: NativeAnsiLayoutRow[];
  document: string;
}

interface NativeTerminalBinding {
  wrapAnsi(value: string, width: number, initialStyle?: string): NativeWrappedAnsiResult;
  layoutAnsiDocument(value: string, width: number): NativeAnsiTextLayout;
}

export type NativeTerminalEngineMode = 'auto' | 'on' | 'off';

export interface NativeTerminalEngineStatus {
  mode: NativeTerminalEngineMode;
  available: boolean;
  error?: string;
}

const require = createRequire(import.meta.url);
let binding: NativeTerminalBinding | undefined;
let loadAttempted = false;
let loadError = '';

function getMode(): NativeTerminalEngineMode {
  const configured = process.env.HAJI_NATIVE_RENDERER?.trim().toLowerCase();
  return configured === 'on' || configured === 'off' ? configured : 'auto';
}

function loadBinding(): NativeTerminalBinding | undefined {
  const mode = getMode();
  if (mode === 'off') return undefined;
  if (loadAttempted) return binding;
  loadAttempted = true;

  try {
    const moduleName = `./haji_terminal_engine.${process.platform}-${process.arch}.node`;
    binding = require(moduleName) as NativeTerminalBinding;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    if (mode === 'on') {
      throw new Error(`原生终端渲染引擎加载失败：${loadError}`);
    }
  }
  return binding;
}

export function getNativeTerminalEngineStatus(): NativeTerminalEngineStatus {
  const mode = getMode();
  if (mode === 'off') return { mode, available: false };
  try {
    const available = Boolean(loadBinding());
    return { mode, available, error: available || !loadError ? undefined : loadError };
  } catch (error) {
    return {
      mode,
      available: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function tryNativeWrapAnsi(
  value: string,
  width: number,
  initialStyle = ''
): NativeWrappedAnsiResult | undefined {
  const native = loadBinding();
  if (!native) return undefined;
  try {
    return native.wrapAnsi(value, width, initialStyle);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    binding = undefined;
    if (getMode() === 'on') {
      throw new Error(`原生终端软换行失败：${loadError}`);
    }
    return undefined;
  }
}

export function tryNativeLayoutAnsiDocument(
  value: string,
  width: number
): NativeAnsiTextLayout | undefined {
  const native = loadBinding();
  if (!native) return undefined;
  try {
    return native.layoutAnsiDocument(value, width);
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    binding = undefined;
    if (getMode() === 'on') {
      throw new Error(`原生终端文档布局失败：${loadError}`);
    }
    return undefined;
  }
}
