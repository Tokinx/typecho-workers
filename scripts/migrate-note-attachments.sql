-- 迁移历史笔记附件：把 typecho_fields.note_images（旧 Wing 迁移的图片附件 ID 数组）
-- 合并进 typecho_fields.note_attachments，并删除 note_images 行。
-- 幂等：重复执行结果不变。执行前建议先备份（wrangler d1 export / 导出 SQL）。
-- 注意：SQLite JSON1（json_each / json_group_array）在本地与 D1 均可用。

-- 1) 已有 note_attachments 行的笔记：把 note_images 的 ID 去重合并进去
UPDATE typecho_fields AS target
SET str_value = (
  SELECT json_group_array(DISTINCT value)
  FROM (
    SELECT value FROM json_each(target.str_value)
    UNION
    SELECT value FROM json_each((
      SELECT source.str_value FROM typecho_fields AS source
      WHERE source.cid = target.cid AND source.name = 'note_images'
        AND source.str_value IS NOT NULL AND source.str_value <> ''
    ))
  )
)
WHERE target.name = 'note_attachments'
  AND target.str_value IS NOT NULL AND target.str_value <> ''
  AND EXISTS (
    SELECT 1 FROM typecho_fields AS source
    WHERE source.cid = target.cid AND source.name = 'note_images'
      AND source.str_value IS NOT NULL AND source.str_value <> ''
  );

-- 2) 只有 note_images、没有 note_attachments 的笔记：直接转写为 note_attachments
INSERT OR IGNORE INTO typecho_fields (cid, name, type, str_value, int_value, float_value)
SELECT source.cid, 'note_attachments', 'str',
       (SELECT json_group_array(DISTINCT value) FROM json_each(source.str_value)),
       0, 0
FROM typecho_fields AS source
WHERE source.name = 'note_images'
  AND source.str_value IS NOT NULL AND source.str_value <> ''
  AND NOT EXISTS (
    SELECT 1 FROM typecho_fields AS existing
    WHERE existing.cid = source.cid AND existing.name = 'note_attachments'
  );

-- 3) 清理旧的 note_images 行
DELETE FROM typecho_fields WHERE name = 'note_images';
