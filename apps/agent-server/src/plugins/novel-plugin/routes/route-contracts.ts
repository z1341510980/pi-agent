import { Type } from 'typebox'

export const emptyQuerySchema = Type.Object({}, { additionalProperties: true })

export const standardResponseSchema = {
  200: Type.Any(),
  400: Type.Any(),
  404: Type.Any(),
  409: Type.Any(),
}
