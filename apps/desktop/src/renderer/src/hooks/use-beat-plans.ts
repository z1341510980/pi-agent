import { useCallback, useEffect } from 'react'
import { listBeatPlans } from '@/api/novel-client'
import { useNovelBeatStore } from '@/stores/novel-beat-store'

/**
 * 节拍表加载器：挂在项目级常驻组件（ProjectTree）上，
 * 项目切换时清空并重拉；同项目重复挂载不重复请求。
 *
 * 节拍分组（BeatPlanGroup）折叠即卸载，加载不能依赖它，
 * 否则大纲树章节行的节拍徽标拿不到数据。
 */
export function useBeatPlansLoader(projectId: string): {
  reload: () => Promise<void>
} {
  const setBeats = useNovelBeatStore((s) => s.setBeats)
  const loadedProjectId = useNovelBeatStore((s) => s.loadedProjectId)

  const reload = useCallback(async () => {
    try {
      const result = await listBeatPlans(projectId)
      setBeats(projectId, result.beats)
    } catch (err) {
      console.error('[useBeatPlansLoader] 加载节拍表失败:', err)
    }
  }, [projectId, setBeats])

  useEffect(() => {
    if (loadedProjectId !== projectId) {
      useNovelBeatStore.getState().clear()
      void reload()
    }
  }, [projectId, loadedProjectId, reload])

  return { reload }
}
