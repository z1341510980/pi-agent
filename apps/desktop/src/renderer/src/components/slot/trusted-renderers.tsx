import type { ReactElement } from 'react'
import { BookOpen, ArrowRight } from 'lucide-react'
import { NovelWorkspace } from '../novel/novel-workspace'
import { NovelDiscussionSettingsPanel } from '../novel/discussion-settings-panel'
import { Button } from '../ui/button'
import {
  InfiniteCanvasNavigationContribution,
  InfiniteCanvasWorkspace
} from '../infinite-canvas/infinite-canvas-workspace'
import { InfiniteCanvasMediaSettings } from '../infinite-canvas/media-settings-panel'

/**
 * 受信任 renderer：桌面构建产物中的静态组件。
 *
 * 只有宿主能把它们加进 slot-context 的白名单；服务端只能引用 rendererKey，
 * 不能下发可执行代码（动态 bundle 属 P3）。
 */

/** P2 示例：导航栏 / 插件页顶部使用的小卡片。 */
export function HelloPanelContribution(props: Record<string, unknown>): ReactElement {
  const initialGreetCount =
    typeof props.initialGreetCount === 'number' ? props.initialGreetCount : 0
  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-700">
      Hello 插件已启用（累计问候：{initialGreetCount}）
    </div>
  )
}

/** P2 示例：占据整个主工作区的插件页面。 */
export function HelloWorkspaceContribution(props: Record<string, unknown>): ReactElement {
  const title = typeof props.title === 'string' ? props.title : 'Hello 插件工作区'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-subtle">
      <h2 className="text-lg text-text">{title}</h2>
      <p className="text-sm">这是由插件贡献到 workspace.main 的示例页面。</p>
    </div>
  )
}

/** P2 示例：右栏 tab 内容。 */
export function HelloRightPanelContribution(props: Record<string, unknown>): ReactElement {
  const note = typeof props.note === 'string' ? props.note : '插件可以在右栏提供自己的检查视图。'
  return <div className="p-3 text-sm text-subtle">{note}</div>
}

/** Builtin novel workspace contribution. The host injects the navigation callback. */
export function NovelWorkspaceContribution(props: Record<string, unknown>): ReactElement {
  const onClose =
    typeof props.onClose === 'function' ? (props.onClose as () => void) : () => undefined
  // active 由 App 外壳注入：keep-alive 隐藏挂载时为 false（工作台让出全局按键）
  const active = props.active !== false
  return <NovelWorkspace onClose={onClose} active={active} />
}

/** Builtin novel navigation contribution. */
export function NovelNavigationContribution(props: Record<string, unknown>): ReactElement {
  const onNavigate =
    typeof props.onNavigate === 'function'
      ? (props.onNavigate as (view: string) => void)
      : undefined
  const currentView = typeof props.currentView === 'string' ? props.currentView : ''
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`relative size-9 ${currentView === 'plugin:novel' ? 'text-text' : 'text-subtle hover:text-text hover:bg-accent'}`}
      aria-label="小说创作"
      aria-current={currentView === 'plugin:novel' ? 'page' : undefined}
      title="小说创作"
      onClick={() => onNavigate?.('plugin:novel')}
    >
      <BookOpen className="size-4" />
    </Button>
  )
}

const SHOWCASE_ROLES = [
  { name: '导演', x: 76, y: 76, delay: '0s' },
  { name: '写手', x: 150, y: 46, delay: '.5s' },
  { name: '评审', x: 280, y: 90, delay: '1s' },
  { name: '记忆', x: 400, y: 124, delay: '1.5s' }
] as const

/**
 * Builtin novel home-showcase contribution：首页的电影感展示卡。
 *
 * 深色渐变舞台 + 叙事弧线上的四个发光角色节点，点击 CTA 进入小说工作台。
 */
export function NovelHomeShowcaseContribution(props: Record<string, unknown>): ReactElement {
  const onNavigate =
    typeof props.onNavigate === 'function'
      ? (props.onNavigate as (view: string) => void)
      : undefined
  return (
    <div className="novel-showcase relative overflow-hidden rounded-[28px] px-8 py-10 sm:px-12 sm:py-12">
      {/* 漂移辉光 */}
      <div
        aria-hidden="true"
        className="novel-showcase-orb pointer-events-none absolute -right-24 -top-32 size-96 rounded-full bg-[radial-gradient(circle,rgba(103,158,254,0.4),transparent_65%)] blur-2xl"
      />
      <div
        aria-hidden="true"
        className="novel-showcase-orb pointer-events-none absolute -bottom-40 -left-20 size-80 rounded-full bg-[radial-gradient(circle,rgba(245,158,11,0.22),transparent_65%)] blur-2xl"
        style={{ animationDelay: '-7s' }}
      />

      <div className="relative grid items-center gap-10 lg:grid-cols-[1fr_400px]">
        <div className="min-w-0">
          <p className="m-0 inline-flex h-6 items-center rounded-full border border-white/15 bg-white/5 px-2.5 text-[11px] font-medium uppercase tracking-[0.18em] text-blue-200/90">
            小说创作
          </p>
          <h3 className="m-0 mt-4 text-balance text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            一部小说，
            <span className="bg-gradient-to-r from-blue-300 to-[var(--dsw-static-deepseek-400)] bg-clip-text text-transparent">
              四个 Agent
            </span>
          </h3>
          <p className="m-0 mt-3 max-w-md text-pretty text-sm leading-relaxed text-slate-400">
            导演搭骨架，写手落笔，评审把关，记忆守护每一处伏笔——长篇创作从此是一条流水线。
          </p>
          <button
            type="button"
            onClick={() => onNavigate?.('plugin:novel')}
            className="group mt-7 inline-flex h-10 items-center gap-1.5 rounded-full bg-white pl-5 pr-4 text-sm font-medium text-slate-900 outline-none transition-[background-color,transform] duration-150 ease-[var(--ds-ease-in-out)] hover:bg-blue-50 focus-visible:ring-3 focus-visible:ring-white/60 active:scale-[0.97]"
          >
            打开工作台
            <ArrowRight
              className="size-4 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </button>
        </div>

        {/* 叙事弧线：四个角色节点 */}
        <svg
          viewBox="0 0 520 190"
          className="hidden w-full lg:block"
          role="img"
          aria-label="导演、写手、评审、记忆四个 Agent 沿叙事弧线协作"
        >
          <defs>
            <linearGradient id="novel-showcase-arc" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#679efe" stopOpacity="0.15" />
              <stop offset="55%" stopColor="#679efe" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#f7ad31" stopOpacity="0.85" />
            </linearGradient>
            <radialGradient id="novel-showcase-node">
              <stop offset="0%" stopColor="#dbe7ff" />
              <stop offset="100%" stopColor="#679efe" />
            </radialGradient>
          </defs>
          <path
            d="M 8 150 C 100 20 190 24 268 84 C 330 132 420 148 512 58"
            fill="none"
            stroke="url(#novel-showcase-arc)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {SHOWCASE_ROLES.map((role) => (
            <g key={role.name}>
              <circle
                cx={role.x}
                cy={role.y}
                r="9"
                fill="none"
                stroke="#679efe"
                strokeOpacity="0.35"
                className="novel-showcase-ring"
                style={{ animationDelay: role.delay }}
              />
              <circle cx={role.x} cy={role.y} r="4" fill="url(#novel-showcase-node)" />
              <text x={role.x} y={role.y + 26} textAnchor="middle" fontSize="12" fill="#94a3b8">
                {role.name}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}

export function InfiniteCanvasWorkspaceContribution(props: Record<string, unknown>): ReactElement {
  const onClose = typeof props.onClose === 'function' ? (props.onClose as () => void) : undefined
  // active 由 App 外壳注入：keep-alive 隐藏挂载时为 false（工作台让出全局按键）
  const active = props.active !== false
  return <InfiniteCanvasWorkspace onClose={onClose} active={active} />
}

export { InfiniteCanvasNavigationContribution }

/** novel 插件设置面板：群聊模式设置（plugin-settings slot）。 */
export function NovelDiscussionSettingsContribution(): ReactElement {
  return <NovelDiscussionSettingsPanel />
}

/** infinite-canvas 插件设置面板：媒体生成 Provider 配置（plugin-settings slot）。 */
export function InfiniteCanvasMediaSettingsContribution(): ReactElement {
  return <InfiniteCanvasMediaSettings />
}
