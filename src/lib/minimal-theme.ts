import { loadThemeConfig } from '@/lib/theme';

const THEME_ID = 'typecho-theme-minimal';

export interface MinimalThemeSettings {
  logoUrl: string;
  sidebarBlock: string[];
}

export function loadMinimalThemeSettings(options: Record<string, any>): MinimalThemeSettings {
  const config = loadThemeConfig(options, THEME_ID);
  const sidebarBlock = Array.isArray(config.sidebarBlock)
    ? config.sidebarBlock.map(String)
    : [];
  return {
    logoUrl: typeof config.logoUrl === 'string' ? config.logoUrl.trim() : '',
    sidebarBlock,
  };
}

export function minimalSidebarEnabled(settings: MinimalThemeSettings, block: string): boolean {
  return settings.sidebarBlock.includes(block);
}
