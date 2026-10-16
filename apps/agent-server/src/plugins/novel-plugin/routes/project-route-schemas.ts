import { Type } from 'typebox'

export const projectIdParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) })

const targetPlatformSchema = Type.Union([
  Type.Literal('fanqie'),
  Type.Literal('qidian'),
  Type.Literal('zhihu_yanyan'),
  Type.Literal('general'),
])

const askStoryPolicySchema = Type.Union([
  Type.Literal('legacy'),
  Type.Literal('directorReviewerOff'),
  Type.Literal('allOffWithReferences'),
  Type.Null(),
])

const novelModelIdSchema = Type.Union([
  Type.Null(),
  Type.String({ minLength: 3, pattern: '^[^:]+:.+$' }),
])

export const createProjectBodySchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  genre: Type.String({ minLength: 1, maxLength: 50 }),
  synopsis: Type.Optional(Type.String({ maxLength: 5000, default: '' })),
  targetWords: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  targetPlatform: Type.Optional(targetPlatformSchema),
  novelAskStoryPolicy: Type.Optional(askStoryPolicySchema),
}, { additionalProperties: false })

export const updateProjectBodySchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  genre: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  synopsis: Type.Optional(Type.String({ maxLength: 5000 })),
  targetWords: Type.Optional(Type.Integer({ minimum: 0 })),
  targetPlatform: Type.Optional(Type.Union([targetPlatformSchema, Type.Null()])),
  novelAskStoryPolicy: Type.Optional(askStoryPolicySchema),
  currentVolume: Type.Optional(Type.Integer({ minimum: 1 })),
  currentChapter: Type.Optional(Type.Integer({ minimum: 0 })),
  currentStage: Type.Optional(Type.Union([
    Type.Literal('setup'),
    Type.Literal('rising'),
    Type.Literal('climax'),
    Type.Literal('falling'),
    Type.Literal('resolution'),
  ])),
  status: Type.Optional(Type.Union([
    Type.Literal('active'),
    Type.Literal('paused'),
    Type.Literal('completed'),
  ])),
  outline: Type.Optional(Type.String({ maxLength: 20_000 })),
  novelModelId: Type.Optional(novelModelIdSchema),
}, { additionalProperties: false })
