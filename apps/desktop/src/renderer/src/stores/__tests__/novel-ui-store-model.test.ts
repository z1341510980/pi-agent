import { beforeEach, describe, expect, it } from 'vitest'
import { useNovelUiStore } from '../novel-ui-store'

const UI_STORE_KEY = 'wenlang-agent-novel-ui'

beforeEach(() => {
  localStorage.clear()
  useNovelUiStore.setState({ selectedAgentModel: null })
})

describe('小说 Agent 模型偏好', () => {
  it('跨项目状态重置和 store 重新加载后仍保留最近选择', async () => {
    const selectedModel = {
      provider: 'openai',
      modelId: 'gpt-5',
      thinkingLevel: 'high' as const
    }

    useNovelUiStore.getState().setSelectedAgentModel(selectedModel)
    useNovelUiStore.getState().resetForProjectSwitch()

    expect(useNovelUiStore.getState().selectedAgentModel).toEqual(selectedModel)

    const persisted = localStorage.getItem(UI_STORE_KEY)
    expect(persisted).not.toBeNull()

    useNovelUiStore.setState({ selectedAgentModel: null })
    localStorage.setItem(UI_STORE_KEY, persisted!)
    await useNovelUiStore.persist.rehydrate()

    expect(useNovelUiStore.getState().selectedAgentModel).toEqual(selectedModel)
  })
})
