export type TuiLayoutMode = 'wide' | 'comfortable' | 'compact' | 'narrow' | 'minimal';

export type TuiHeaderMode = 'full' | 'compact' | 'hidden';

export type TuiStatusDetail = 'full' | 'compact' | 'minimal';

export interface TuiLayout {
  mode: TuiLayoutMode;
  safeWidth: number;
  safeHeight: number;
  chatPadding: number;
  headerMode: TuiHeaderMode;
  statusDetail: TuiStatusDetail;
  panelRows: number;
  showHints: boolean;
}

interface TuiLayoutProfile {
  chatPadding: number;
  headerMode: TuiHeaderMode;
  statusDetail: TuiStatusDetail;
  panelRows: number;
  showHints: boolean;
}

const PROFILES: Readonly<Record<TuiLayoutMode, TuiLayoutProfile>> = {
  wide: {
    chatPadding: 3,
    headerMode: 'full',
    statusDetail: 'full',
    panelRows: 8,
    showHints: true
  },
  comfortable: {
    chatPadding: 2,
    headerMode: 'full',
    statusDetail: 'full',
    panelRows: 6,
    showHints: true
  },
  compact: {
    chatPadding: 1,
    headerMode: 'compact',
    statusDetail: 'compact',
    panelRows: 4,
    showHints: true
  },
  narrow: {
    chatPadding: 1,
    headerMode: 'compact',
    statusDetail: 'minimal',
    panelRows: 2,
    showHints: false
  },
  minimal: {
    chatPadding: 0,
    headerMode: 'hidden',
    statusDetail: 'minimal',
    panelRows: 0,
    showHints: false
  }
};

function normalizeDimension(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
}

export function resolveTuiLayoutMode(columns: number, rows: number): TuiLayoutMode {
  const safeColumns = normalizeDimension(columns, 'columns');
  const safeRows = normalizeDimension(rows, 'rows');

  if (safeColumns < 24 || safeRows < 10) return 'minimal';
  if (safeColumns < 40) return 'narrow';
  if (safeColumns < 60) return 'compact';
  if (safeColumns < 100) return 'comfortable';
  return 'wide';
}

export function resolvePanelRowBudget(rows: number): number {
  const safeRows = normalizeDimension(rows, 'rows');
  if (safeRows < 10) return 0;
  if (safeRows < 16) return 1;
  if (safeRows < 24) return 2;
  if (safeRows < 32) return 4;
  if (safeRows < 40) return 6;
  return 8;
}

export function resolveTuiLayout(columns: number, rows: number): TuiLayout {
  const safeColumns = normalizeDimension(columns, 'columns');
  const safeRows = normalizeDimension(rows, 'rows');
  const mode = resolveTuiLayoutMode(safeColumns, safeRows);
  const profile = PROFILES[mode];

  if (mode === 'minimal') {
    return {
      mode,
      safeWidth: safeColumns - 1,
      safeHeight: safeRows,
      ...profile
    };
  }

  const short = safeRows < 16;
  const mediumHeight = safeRows < 24;
  const headerMode = short
    ? 'hidden'
    : mediumHeight && profile.headerMode === 'full'
      ? 'compact'
      : profile.headerMode;
  const statusDetail = short
    ? 'minimal'
    : mediumHeight && profile.statusDetail === 'full'
      ? 'compact'
      : profile.statusDetail;
  return {
    mode,
    safeWidth: safeColumns - 1,
    safeHeight: safeRows,
    chatPadding: profile.chatPadding,
    headerMode,
    statusDetail,
    panelRows: Math.min(profile.panelRows, resolvePanelRowBudget(safeRows)),
    showHints: profile.showHints && !short
  };
}
