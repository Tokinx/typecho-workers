import type { PluginConfigField } from '@/lib/plugin';

/** Value used by admin clients when a stored secret is left unchanged. */
export const SECRET_PLACEHOLDER = '__PLUGIN_CONFIG_SECRET__';

function isSecretField(field: PluginConfigField | undefined): boolean {
  return field?.type === 'password' || field?.type === 'hidden';
}

export function maskPluginConfigSecrets(
  configDef: Record<string, PluginConfigField>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = configDef[key];
    if (isSecretField(field)) {
      out[key] = raw && String(raw).length > 0 ? SECRET_PLACEHOLDER : '';
    } else if (field?.type === 'repeatable' && Array.isArray(raw)) {
      const itemFields = field.itemFields || {};
      out[key] = raw.map(row => {
        if (!row || typeof row !== 'object') return row;
        const masked: Record<string, unknown> = {};
        for (const [innerKey, innerVal] of Object.entries(row as Record<string, unknown>)) {
          masked[innerKey] = isSecretField(itemFields[innerKey]) && innerVal && String(innerVal).length > 0
            ? SECRET_PLACEHOLDER
            : innerVal;
        }
        return masked;
      });
    } else {
      out[key] = raw;
    }
  }
  return out;
}

export function restorePluginConfigSecrets(
  configDef: Record<string, PluginConfigField>,
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const [key, field] of Object.entries(configDef)) {
    if (isSecretField(field) && incoming[key] === SECRET_PLACEHOLDER) {
      out[key] = previous[key];
    } else if (field.type === 'repeatable' && Array.isArray(incoming[key])) {
      const itemFields = field.itemFields || {};
      const previousRows = Array.isArray(previous[key]) ? (previous[key] as unknown[]) : [];
      out[key] = (incoming[key] as unknown[]).map((row, idx) => {
        if (!row || typeof row !== 'object') return row;
        const prevRow = (previousRows[idx] as Record<string, unknown>) || {};
        const merged: Record<string, unknown> = { ...(row as Record<string, unknown>) };
        for (const [innerKey, innerField] of Object.entries(itemFields)) {
          if (isSecretField(innerField) && merged[innerKey] === SECRET_PLACEHOLDER) {
            merged[innerKey] = prevRow[innerKey];
          }
        }
        return merged;
      });
    }
  }
  return out;
}
