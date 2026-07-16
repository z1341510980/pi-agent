-- 项目「开局上交异界，我的背后是国家」旧伏笔数据清理。
-- 执行前必须使用 SQLite .backup 备份线上数据库。
-- 结论：22 条旧记录中保留 4 条真正伏笔（3 条活跃、1 条已回收），
-- 将 5 组仍需追踪的信息改为线索，其余普通事实或重复冲突从伏笔系统移除。

BEGIN IMMEDIATE;

-- 修复旧项目游标：第 1—9 章已有正文，第 10 章仍为占位。
UPDATE novel_projects
SET current_chapter = 9, updated_at = unixepoch()
WHERE id = '132d4d7d-f98d-4b01-99db-9c3e8649825e';

-- 1. 玉佩与两界通道的来源/完整触发规则（暗线）。
UPDATE novel_foreshadowing
SET description = '叶明远的穿越与玉佩建立两界通道并非单纯“触碰即触发”：灵力只能激活现有连接，真正令成对玉佩分隔两界、选择叶明远并撕开位面边界的条件仍未揭示。',
    category = 'secret', status = 'planted', first_chapter = 1, last_chapter = 1,
    recover_by_chapter = NULL, chapter_spans = '[[1,1]]',
    beats = '[{"chapter":1,"type":"plant","note":"触碰穿越、成对玉佩分隔两界，且后续触碰不再重复穿越"}]',
    linked_clues = '["0c763c5c-0d4d-48a0-b4b9-c032cd3d2cb7","d151231d-c87e-4083-8fa8-f2ce7f814f0e","e9bd35f2-798a-431d-984a-23fb74c68e21"]',
    updated_at = unixepoch()
WHERE id = 'a140c7ba-9104-410f-a533-dc2184f1b9b4';

-- 2. 魔渊裂世与穿越时间重合（全书级暗线）。
UPDATE novel_foreshadowing
SET description = '魔渊裂世发生的时间与叶明远穿越修真界的时间重合；两件事是否由同一次位面边界异常引发，以及裂缝背后的真正成因，是隐藏在求生与两界合作明线下的核心问题。',
    category = 'secret', status = 'planted', first_chapter = 1, last_chapter = 1,
    recover_by_chapter = NULL, chapter_spans = '[[1,1]]',
    beats = '[{"chapter":1,"type":"plant","note":"交代魔渊裂世与主角穿越时间重合，但不解释因果"}]',
    linked_clues = '[]', updated_at = unixepoch()
WHERE id = 'b44a6513-fb62-4570-b243-96d617f696ce';

-- 3. 1998 年信号证明两界并非首次接触（已完成一次阶段性回收）。
UPDATE novel_foreshadowing
SET description = '1998年西北核基地的七次周期性脉冲与玉佩信号同源，证明叶明远之前已有力量触及两界边界，并为追查更早的两界接触史留下入口。',
    category = 'secret', status = 'recovered', first_chapter = 2, last_chapter = 4,
    recover_by_chapter = 4, chapter_spans = '[[2,2],[4,4]]',
    beats = '[{"chapter":2,"type":"plant","note":"发现1998年脉冲与当前信号波形匹配"},{"chapter":4,"type":"payoff","note":"确认旧事件与两界信号存在关联，完成阶段性回收"}]',
    linked_clues = '[]', updated_at = unixepoch()
WHERE id = '617ed3cb-1130-40f5-b52e-52270035a7e5';

-- 4. 两界人类同源/分化之谜；第 10 章按现有章纲安排一次强化。
UPDATE novel_foreshadowing
SET description = '《引气诀》的七处关键节点在蓝星人体解剖中不存在，但叶明远体内可以运行；这一差异指向两界人类为何高度相似却存在修炼结构分化，以及二者是否源于同一远古文明。',
    category = 'secret', status = 'planted', first_chapter = 8, last_chapter = 10,
    recover_by_chapter = NULL, chapter_spans = '[[8,8],[10,10]]',
    beats = '[{"chapter":8,"type":"plant","note":"发现七处蓝星解剖不存在的功法节点"},{"chapter":10,"type":"reinforce","note":"通过内视与身体模型验证七处节点并出现完整图形"}]',
    linked_clues = '[]', updated_at = unixepoch()
WHERE id = '0b0daf55-a3be-47ee-9dd3-dfb560bc82d0';

-- 普通疑点进入线索系统。
INSERT OR IGNORE INTO novel_clues
  (id, project_id, description, points_to, progress, current_step, next_step, is_misleading, linked_foreshadow, created_at, updated_at)
VALUES
  ('0c763c5c-0d4d-48a0-b4b9-c032cd3d2cb7', '132d4d7d-f98d-4b01-99db-9c3e8649825e',
   '玉佩没有电路或电子元件，却会响应叶明远注入的微弱灵力并维持跨界通讯。',
   '玉佩的跨界能力依赖非科技机制和灵力，但连接来源与完整触发规则仍未知。', 30,
   '已确认无电子结构，微弱灵力可以激活通讯。', '比较通讯、收纳、传物时的灵力消耗与触发条件。', 0,
   'a140c7ba-9104-410f-a533-dc2184f1b9b4', unixepoch(), unixepoch()),
  ('d151231d-c87e-4083-8fa8-f2ce7f814f0e', '132d4d7d-f98d-4b01-99db-9c3e8649825e',
   '祖传玉佩原本成对，一半随叶明远穿越，另一半留在蓝星并成为通讯锚点。',
   '成对玉佩可能是两界连接装置的一部分，其分隔原因与完整形态尚未查明。', 25,
   '已确认两枚玉佩分别位于两个世界。', '查明两枚玉佩为何分隔两界，以及能否重建完整通道。', 0,
   'a140c7ba-9104-410f-a533-dc2184f1b9b4', unixepoch(), unixepoch()),
  ('e9bd35f2-798a-431d-984a-23fb74c68e21', '132d4d7d-f98d-4b01-99db-9c3e8649825e',
   '叶明远使用玉佩收纳物品后出现轻微虚脱。',
   '玉佩收纳和传物能力会消耗灵力，并可能存在容量、距离或次数限制。', 25,
   '已确认收纳后出现体力或灵力消耗。', '记录不同物品的体积、质量与消耗，找出能力边界。', 0,
   'a140c7ba-9104-410f-a533-dc2184f1b9b4', unixepoch(), unixepoch()),
  ('099de424-801e-4c75-9c24-7b9bb0f6a4d5', '132d4d7d-f98d-4b01-99db-9c3e8649825e',
   '孙疤尸体被藏在废弃巷道碎石堆下，掩埋不深。',
   '尸体一旦被发现，会暴露孙疤遇害及叶明远隐藏秘密的事实。', 15,
   '尸体尚未被发现，但废弃巷道入口可能被赵岩或矿工注意。', '观察矿工动向、尸体痕迹和赵岩是否安排搜查。', 0,
   NULL, unixepoch(), unixepoch()),
  ('b00a4e9a-df9d-47f5-89ea-4d0833eacd25', '132d4d7d-f98d-4b01-99db-9c3e8649825e',
   '赵岩询问了修为和怪异铁器，却对矿坑中失踪的孙疤只字未提。',
   '赵岩可能已经知道孙疤失踪的内情，或正在等待叶明远主动露出破绽。', 10,
   '已确认赵岩的沉默与其掌握矿工动向的职责不符。', '通过赵岩后续言行、矿工名单变化和废弃巷道动向验证其知情程度。', 0,
   NULL, unixepoch(), unixepoch());

-- 清除外部引用后删除不合格伏笔；冲突系统中已有对应记录的风险不重复创建。
UPDATE novel_hooks
SET linked_foreshadow_id = NULL, updated_at = unixepoch()
WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
  AND linked_foreshadow_id IS NOT NULL
  AND linked_foreshadow_id NOT IN (
    'a140c7ba-9104-410f-a533-dc2184f1b9b4', 'b44a6513-fb62-4570-b243-96d617f696ce',
    '617ed3cb-1130-40f5-b52e-52270035a7e5', '0b0daf55-a3be-47ee-9dd3-dfb560bc82d0'
  );

UPDATE novel_information_layers
SET linked_foreshadows = json(COALESCE((
  SELECT json_group_array(value)
  FROM json_each(novel_information_layers.linked_foreshadows)
  WHERE value IN (
    'a140c7ba-9104-410f-a533-dc2184f1b9b4', 'b44a6513-fb62-4570-b243-96d617f696ce',
    '617ed3cb-1130-40f5-b52e-52270035a7e5', '0b0daf55-a3be-47ee-9dd3-dfb560bc82d0'
  )
), '[]')), updated_at = unixepoch()
WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e';

DELETE FROM novel_memory_events
WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
  AND event_type = 'foreshadow_change'
  AND entity_id NOT IN (
    'a140c7ba-9104-410f-a533-dc2184f1b9b4', 'b44a6513-fb62-4570-b243-96d617f696ce',
    '617ed3cb-1130-40f5-b52e-52270035a7e5', '0b0daf55-a3be-47ee-9dd3-dfb560bc82d0'
  );

DELETE FROM novel_edges
WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
  AND (source_id IN (SELECT id FROM novel_foreshadowing WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
       AND id NOT IN ('a140c7ba-9104-410f-a533-dc2184f1b9b4','b44a6513-fb62-4570-b243-96d617f696ce','617ed3cb-1130-40f5-b52e-52270035a7e5','0b0daf55-a3be-47ee-9dd3-dfb560bc82d0'))
    OR target_id IN (SELECT id FROM novel_foreshadowing WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
       AND id NOT IN ('a140c7ba-9104-410f-a533-dc2184f1b9b4','b44a6513-fb62-4570-b243-96d617f696ce','617ed3cb-1130-40f5-b52e-52270035a7e5','0b0daf55-a3be-47ee-9dd3-dfb560bc82d0')));

DELETE FROM novel_foreshadowing
WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
  AND id NOT IN (
    'a140c7ba-9104-410f-a533-dc2184f1b9b4', 'b44a6513-fb62-4570-b243-96d617f696ce',
    '617ed3cb-1130-40f5-b52e-52270035a7e5', '0b0daf55-a3be-47ee-9dd3-dfb560bc82d0'
  );

DELETE FROM novel_node_positions
WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
  AND node_type = 'foreshadow'
  AND entity_id NOT IN (SELECT id FROM novel_foreshadowing WHERE project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e');

-- 历史快照只保留在当时已经存在的合格伏笔，防止中间章重写继续读到旧误分类。
UPDATE novel_memory_snapshots AS snapshot
SET snapshot_data = json_set(
  snapshot.snapshot_data,
  '$.foreshadowing',
  json(COALESCE((
    SELECT json_group_array(json(item.value))
    FROM json_each(snapshot.snapshot_data, '$.foreshadowing') AS item
    WHERE (
      (json_extract(item.value, '$.id') IN (
        'a140c7ba-9104-410f-a533-dc2184f1b9b4', 'b44a6513-fb62-4570-b243-96d617f696ce'
      ) AND snapshot.chapter_number >= 1)
      OR (json_extract(item.value, '$.id') = '617ed3cb-1130-40f5-b52e-52270035a7e5' AND snapshot.chapter_number >= 2)
      OR (json_extract(item.value, '$.id') = '0b0daf55-a3be-47ee-9dd3-dfb560bc82d0' AND snapshot.chapter_number >= 8)
    )
  ), '[]'))
)
WHERE snapshot.project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
  AND snapshot.snapshot_type = 'full'
  AND json_valid(snapshot.snapshot_data);

-- 将重分类后的线索按首次出现章节写回历史快照，既不丢线索，也不把未来信息倒灌到旧章。
UPDATE novel_memory_snapshots AS snapshot
SET snapshot_data = json_set(
  snapshot.snapshot_data,
  '$.clues',
  json(COALESCE((
    SELECT json_group_array(json_object(
      'id', clue.id, 'projectId', clue.project_id, 'description', clue.description,
      'pointsTo', clue.points_to, 'progress', clue.progress, 'currentStep', clue.current_step,
      'nextStep', clue.next_step, 'isMisleading', clue.is_misleading,
      'linkedForeshadow', clue.linked_foreshadow, 'createdAt', clue.created_at, 'updatedAt', clue.updated_at
    ))
    FROM novel_clues AS clue
    WHERE clue.project_id = snapshot.project_id
      AND (
        (clue.id IN ('0c763c5c-0d4d-48a0-b4b9-c032cd3d2cb7','d151231d-c87e-4083-8fa8-f2ce7f814f0e') AND snapshot.chapter_number >= 1)
        OR (clue.id = 'e9bd35f2-798a-431d-984a-23fb74c68e21' AND snapshot.chapter_number >= 4)
        OR (clue.id = '099de424-801e-4c75-9c24-7b9bb0f6a4d5' AND snapshot.chapter_number >= 7)
        OR (clue.id = 'b00a4e9a-df9d-47f5-89ea-4d0833eacd25' AND snapshot.chapter_number >= 9)
      )
  ), '[]'))
)
WHERE snapshot.project_id = '132d4d7d-f98d-4b01-99db-9c3e8649825e'
  AND snapshot.snapshot_type = 'full'
  AND json_valid(snapshot.snapshot_data);

COMMIT;
