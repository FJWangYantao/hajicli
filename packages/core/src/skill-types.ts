export type SkillSource = 'user' | 'project';

export interface SkillEntry {
  name: string;
  description: string;
  whenToUse?: string;
  userInvocable: boolean;
  source: SkillSource;
  directory: string;
  manifestPath: string;
  content: string;
  contentHash: string;
}

export interface SkillCatalogItem {
  name: string;
  description: string;
  whenToUse?: string;
  source: SkillSource;
  userInvocable: boolean;
}

export interface SkillActivation {
  name: string;
  source: SkillSource;
  contentHash: string;
  loadedAt: string;
}

export interface SkillScanResult {
  skills: SkillEntry[];
  warnings: string[];
}
