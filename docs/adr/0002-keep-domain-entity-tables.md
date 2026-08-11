# 保留领域分表，不做万能实体表

日期：2026-08-11 状态：已采纳

背景：统一方案诊断阶段曾出现"把冲突/伏笔/线索合并为一张万能实体表以消除重复"的提议。

决策：冲突（intensity/stage/participants/progressionMode）、伏笔（category/status/plantMethod/recoverMethod/beats）、线索（pointsTo/progress/currentStep/nextStep/isMisleading）继续独立建表；跨实体公共信息抽到横切面（novel_entity_appearances 等），而不是合并实体本体。

理由：三者的状态机、字段语义和验收逻辑完全不同（伏笔有 beats 事件链、线索有误导标记、冲突有强度曲线），合并后每条业务规则都要先判断类型再分支，测试矩阵翻倍，且 JSON 化字段会失去列级约束。

反方观点：分表导致"第 N 章出场实体"需要 union 多表。已用 novel_entity_appearances 横切表解决查询问题，无需动摇实体本体建模。
