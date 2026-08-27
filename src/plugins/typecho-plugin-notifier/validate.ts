/**
 * Shared settings validation for beforeSave + custom config API.
 */
import {
  normalizeConfig,
  toFormValues,
  emailInvalidReason,
  isWebhookReady,
} from './config';
import { isValidJsonTemplate } from './templates';

export function validateAndNormalizeSettings(
  settings: Record<string, unknown>,
): { success: true; settings: Record<string, string> } | { success: false; error: string } {
  const config = normalizeConfig(settings);

  const emailErr = emailInvalidReason(config);
  if (emailErr && (config.systemEmail || config.commentEmail || config.replyEmail)) {
    return { success: false, error: `已启用邮件通知，但邮件渠道不可用：${emailErr}` };
  }
  if (config.systemWebhook && !isWebhookReady(config)) {
    return { success: false, error: '已启用「系统通知 · WebHook」，但地址无效或未填写' };
  }
  if (config.commentWebhook && !isWebhookReady(config)) {
    return { success: false, error: '已启用「新评论通知管理员 · WebHook」，但地址无效或未填写' };
  }
  if (config.systemWebhook && !isValidJsonTemplate(config.systemWebhookPayload)) {
    return { success: false, error: '「系统通知 · WebHook」的 JSON 模板不是合法 JSON' };
  }
  if (config.commentWebhook && !isValidJsonTemplate(config.commentWebhookPayload)) {
    return { success: false, error: '「新评论通知 · WebHook」的 JSON 模板不是合法 JSON' };
  }

  return { success: true, settings: toFormValues(config) };
}