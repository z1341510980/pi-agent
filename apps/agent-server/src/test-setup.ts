import { resolve } from 'node:path'

// Keep third-party Pi runtime state writable and isolated during tests. Production
// processes can still provide their own PI_CODING_AGENT_DIR explicitly.
process.env.PI_CODING_AGENT_DIR ??= resolve(process.cwd(), 'tmp', 'pi-agent-runtime')
process.env.PI_DATA_DIR ??= process.env.PI_CODING_AGENT_DIR
