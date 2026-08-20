import { describe, expect, it } from 'vitest'
import { Tracer } from './tracer.js'
import type {
  EventQueryFilter,
  EventRecord,
  EventSeq,
  EventTraceResult,
  LineageTrace,
  Trace,
  TraceEvent,
  TraceId,
  TraceStore,
} from './types.js'

class ForeignKeyTraceStore implements TraceStore {
  readonly traces = new Map<TraceId, Trace>()

  async saveTrace(trace: Trace): Promise<void> {
    this.traces.set(trace.id, copyTrace(trace))
  }

  async appendEvents(traceId: TraceId, events: TraceEvent[]): Promise<void> {
    const trace = this.traces.get(traceId)
    if (!trace) throw new Error(`Missing trace root for ${traceId}`)
    trace.events.push(...events.map(copyEvent))
  }

  async updateTraceStatus(traceId: TraceId, status: Trace['status'], endedAt?: number): Promise<void> {
    const trace = this.traces.get(traceId)
    if (!trace) throw new Error(`Missing trace root for ${traceId}`)
    trace.status = status
    trace.endedAt = endedAt
  }

  async getTrace(traceId: TraceId): Promise<Trace | null> {
    const trace = this.traces.get(traceId)
    return trace ? copyTrace(trace) : null
  }

  async getTraceEvents(traceId: TraceId): Promise<TraceEvent[]> {
    return (this.traces.get(traceId)?.events ?? []).map(copyEvent)
  }

  async getSessionTraces(sessionId: string): Promise<Trace[]> {
    return Array.from(this.traces.values())
      .filter((trace) => trace.sessionId === sessionId)
      .map(copyTrace)
  }

  async queryEvents(_filter: EventQueryFilter): Promise<EventRecord[]> {
    return []
  }

  async traceEvent(_traceId: TraceId, _seq: EventSeq): Promise<EventTraceResult> {
    throw new Error('Not used by this test store')
  }

  async traceSession(_sessionId: string): Promise<LineageTrace> {
    throw new Error('Not used by this test store')
  }
}

function copyEvent(event: TraceEvent): TraceEvent {
  return {
    ...event,
    data: { ...event.data },
    sourceEventSeqs: event.sourceEventSeqs ? [...event.sourceEventSeqs] : undefined,
    metadata: event.metadata ? { ...event.metadata } : undefined,
  }
}

function copyTrace(trace: Trace): Trace {
  const events = trace.events.map(copyEvent)
  return {
    ...trace,
    events,
    rootEvent: events[0],
    metadata: trace.metadata ? { ...trace.metadata } : undefined,
  }
}

describe('Tracer persistence', () => {
  it('persists a trace root before events and can reload the completed run', async () => {
    const store = new ForeignKeyTraceStore()
    const tracer = new Tracer(store)
    const trace = tracer.startTrace({
      sessionId: 'novel:chapter:project-1:1',
      runId: 'writer:run-1',
      metadata: { agentName: '写作 Agent' },
    })

    const request = tracer.addEvent(trace.id, {
      type: 'llm_request',
      data: { modelId: { provider: 'test', modelId: 'model' } },
    })
    tracer.addEvent(trace.id, {
      type: 'assistant_message',
      data: { length: 12 },
      sourceEventSeqs: [request.seq],
    })
    tracer.finishTrace(trace.id)
    await tracer.flush(trace.id)

    const reloaded = await new Tracer(store).getTraceAsync(trace.id)
    expect(reloaded).toMatchObject({
      id: trace.id,
      sessionId: 'novel:chapter:project-1:1',
      runId: 'writer:run-1',
      status: 'completed',
      metadata: { agentName: '写作 Agent' },
    })
    expect(reloaded?.events.map((event) => event.type)).toEqual([
      'run_started',
      'llm_request',
      'assistant_message',
      'run_finished',
    ])
    expect(reloaded?.endedAt).toBeTypeOf('number')
  })
})
