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
  issues: SkillValidationIssue[];
}

export type SkillResourceKind = 'reference' | 'script' | 'asset' | 'resource';

export interface SkillResourceItem {
  path: string;
  kind: SkillResourceKind;
  size: number;
}

export interface SkillResourceList {
  resources: SkillResourceItem[];
  warnings: string[];
}

export interface SkillResourceContent extends SkillResourceItem {
  content: string;
}

export interface SkillValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  skill?: string;
}

export interface SkillValidationResult {
  valid: boolean;
  checkedSkills: number;
  checkedResources: number;
  issues: SkillValidationIssue[];
}
