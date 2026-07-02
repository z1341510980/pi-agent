/**
 * 直接调用 entity_generator.generateAndArrange 复现错误
 * 不通过 HTTP，直接 import 服务端模块
 *
 * 运行：npx tsx apps/agent-server/scripts/e2e-test/probe-generator.ts
 */

import 'dotenv/config'
import { createApp } from '../../src/app.js'

async function main() {
  const app = await createApp()

  // 创建测试项目
  const novelPlugin = app.pluginManager?.getPlugin?.('novel-plugin')
  if (!novelPlugin) {
    console.error('novel-plugin 未加载')
    await app.close()
    process.exit(1)
  }

  // 通过 services 获取 entityGenerator
  const services = (app as any).__novelServices
  if (!services) {
    console.error('novelServices 未挂载')
    await app.close()
    process.exit(1)
  }

  const { store, entityGenerator, orchestrator } = services

  // 创建测试项目
  const project = store.createProject({
    id: randomUUID(),
    title: 'probe-' + Date.now(),
    genre: '玄幻',
    synopsis: '测试',
    targetWords: 50000,
    currentVolume: 1,
    currentChapter: 0,
    currentStage: 'setup',
    status: 'active',
  })
  console.log('项目已创建:', project.id)

  // 创建章节
  const chapter = await services.engine.createChapter(project.id, 1, {
    description: '测试章节',
    type: 'plot_advancement',
    priority: 'high',
  })
  console.log('章节已创建:', chapter.chapterId)

  // 设置章纲
  store.updateChapter(chapter.chapterId, {
    outline: [
      '# 第1章 荒野初遇',
      '',
      '## 场景一：进入荒野',
      '少年叶尘背着家传长剑，独自踏入被称为修者坟场的黑松荒野。',
      '',
      '## 场景二：妖兽袭击',
      '一头赤鬃狼王从雾中扑出，叶尘拔剑迎敌。',
      '',
      '## 场景三：神秘旅人',
      '一名青衣旅人从树梢落下，自称行路人，邀叶尘结伴前行。',
    ].join('\n'),
  })
  console.log('章纲已设置')

  // 调用 generateAndArrange
  console.log('开始调用 generateAndArrange...')
  try {
    const result = await entityGenerator.generateAndArrange(
      project.id,
      1,
      store.getChapter(project.id, 1).outline,
      (evt) => {
        console.log(`[progress] ${evt.phase}: ${evt.message}`)
      },
    )
    console.log('generateAndArrange 成功:', JSON.stringify(result, null, 2))
  } catch (err) {
    console.error('generateAndArrange 失败:', err)
    console.error('stack:', err.stack)
  }

  // 清理
  store.deleteProject(project.id)
  console.log('项目已删除')
  await app.close()
  process.exit(0)
}

function randomUUID() {
  return crypto.randomUUID()
}

main().catch((err) => {
  console.error('未捕获错误:', err)
  process.exit(1)
})
