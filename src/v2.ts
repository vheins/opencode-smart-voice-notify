/**
 * OpenCode V2 adapter for Smart Voice Notify.
 *
 * OpenCode V2 (>= 2.0.x) loads plugins through `@opencode/plugin` and expects a
 * default export shaped as `{ id, setup }` (see `Plugin.define`). The V2 plugin
 * `Context` is very different from the legacy V1 `PluginInput`:
 *
 *   - There is NO `$` shell runner.  We synthesise one on top of
 *     `node:child_process` so the existing audio / TTS / volume helpers keep
 *     working.
 *   - There is NO `client.tui.showToast` and no raw `client` object.  We provide
 *     a thin shim that maps session lookups to `ctx.session.get` and turns
 *     toasts into best-effort no-ops (V2 exposes no plugin-facing toast API).
 *   - Events arrive from `ctx.event.subscribe()` as `{ type, data, created, ... }`
 *     whereas the V1 handler consumes `{ type, properties }`.  We translate V2
 *     events into the V1 shape so the battle-tested notification logic in
 *     `plugin.ts` can be reused verbatim.
 *
 * The V1 implementation is preserved untouched and re-exported as `server` on
 * the package entry point so OpenCode V1 (1.18.29+) keeps working too.
 */

import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

import { Plugin } from '@opencode/plugin';

import { SmartVoiceNotifyPlugin } from './plugin.js';
import type { OpenCodeClient, PluginEvent, SessionGetResult, ShellExecution, ShellResult, ShellRunner } from './types/opencode-sdk.js';

/** Stable plugin identifier reported to OpenCode V2. */
export const PLUGIN_ID = 'smart-voice-notify';

/** Minimal shape of the V2 event envelope we consume. */
interface V2EventEnvelope {
  id?: string;
  type: string;
  created?: number;
  location?: { directory?: string; workspaceID?: string };
  data?: Record<string, unknown>;
}

// ============================================================
// Cross-instance event de-duplication
// ============================================================

/**
 * OpenCode V2 instantiates a server plugin once per location (project
 * directory), yet every instance shares a single process-wide event stream
 * (`ctx.event.subscribe()` maps to `GET /api/event`).  Without a guard each
 * instance reacts to every event, so a single notification is spoken once per
 * loaded location — heard by the user as overlapping / echoing audio.
 *
 * We therefore remember the unique id of each event in a process-wide registry
 * (stored on `globalThis` so it survives module re-evaluation and is shared by
 * every instance) and let only the first instance to observe an event act on
 * it.  Distinct events keep distinct ids, so genuine concurrent notifications
 * are unaffected.
 */
const PROCESSED_EVENT_TTL_MS = 15_000;
const PROCESSED_EVENT_MAX = 1024;
const PROCESSED_EVENTS_KEY = Symbol.for('opencode-smart-voice-notify.processed-events');

interface ProcessedEventRegistry {
  seen: Map<string, number>;
}

const getProcessedEventRegistry = (): ProcessedEventRegistry => {
  const globalStore = globalThis as unknown as Record<symbol, ProcessedEventRegistry | undefined>;
  let registry = globalStore[PROCESSED_EVENTS_KEY];
  if (!registry) {
    registry = { seen: new Map<string, number>() };
    globalStore[PROCESSED_EVENTS_KEY] = registry;
  }
  return registry;
};

/**
 * Record an event id and report whether it had already been handled.
 * Returns `false` (i.e. "not a duplicate") when the id is missing so that an
 * id-less event is never silently dropped.
 */
export const isDuplicateEvent = (eventId: string | undefined): boolean => {
  if (!eventId) return false;

  const registry = getProcessedEventRegistry();
  const now = Date.now();

  if (registry.seen.size >= PROCESSED_EVENT_MAX) {
    for (const [id, timestamp] of registry.seen) {
      if (now - timestamp > PROCESSED_EVENT_TTL_MS) {
        registry.seen.delete(id);
      }
    }
  }

  const previous = registry.seen.get(eventId);
  if (previous !== undefined && now - previous <= PROCESSED_EVENT_TTL_MS) {
    return true;
  }

  registry.seen.set(eventId, now);
  return false;
};

// ============================================================
// Shell runner shim
// ============================================================

const isWindows = process.platform === 'win32';

/** Quote a single interpolated value so it survives the shell as one argument. */
const quoteValue = (value: unknown): string => {
  const text = value === undefined || value === null ? '' : String(value);
  if (isWindows) {
    // cmd.exe: wrap in double quotes, escape embedded double quotes.
    return `"${text.replace(/"/g, '\\"')}"`;
  }
  // POSIX: single-quote, escaping embedded single quotes.
  return `'${text.replace(/'/g, `'\\''`)}'`;
};

/**
 * Build a shell command string from a tagged-template call.  Static template
 * parts are emitted verbatim (so shell syntax such as quotes keeps working)
 * while interpolated values are quoted to become exactly one argument each —
 * matching the semantics the plugin was written against.
 */
const buildCommand = (strings: TemplateStringsArray, values: Array<unknown>): string => {
  let command = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    command += quoteValue(values[i]);
    command += strings[i + 1] ?? '';
  }
  return command;
};

/** Create a single shell execution: a thenable with `.quiet()/.nothrow()/.timeout()`. */
const createShellExecution = (command: string): ShellExecution => {
  let nothrow = false;
  let timedOut = false;
  let child: ReturnType<typeof spawn> | undefined;

  const shellBin = isWindows ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh';
  const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

  const promise = new Promise<ShellResult>((resolve, reject) => {
    const stdoutChunks: Array<Buffer> = [];
    const stderrChunks: Array<Buffer> = [];

    try {
      child = spawn(shellBin, shellArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));

    child.on('error', (error) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (nothrow) {
        resolve({ stdout, stderr, exitCode: 127, text: (enc?: BufferEncoding) => stdout.toString(enc), toString: () => stdout.toString() });
        return;
      }
      reject(Object.assign(error, { stdout, stderr, exitCode: 127 }));
    });

    child.on('close', (code: number | null) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const exitCode = timedOut ? 124 : code ?? 1;
      const result: ShellResult = {
        stdout,
        stderr,
        exitCode,
        text: (enc?: BufferEncoding) => stdout.toString(enc),
        toString: () => stdout.toString(),
      };

      if (exitCode !== 0 && !nothrow) {
        const message = stderr.toString().trim() || `Command failed with exit code ${exitCode}`;
        reject(Object.assign(new Error(message), result));
        return;
      }
      resolve(result);
    });
  });

  const execution = promise as ShellExecution;
  execution.quiet = () => execution;
  execution.nothrow = () => {
    nothrow = true;
    return execution;
  };
  execution.timeout = (milliseconds: number) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill('SIGKILL');
    }, milliseconds);
    // Do not keep the event loop alive purely for the timeout.
    (timer as { unref?: () => void }).unref?.();
    return execution;
  };

  return execution;
};

/** Synthesise a V1-compatible `$` shell runner for the V2 context. */
export const createShellRunner = (): ShellRunner => {
  const runner = ((strings: TemplateStringsArray, ...values: Array<unknown>): ShellExecution =>
    createShellExecution(buildCommand(strings, values))) as ShellRunner;
  return runner;
};

// ============================================================
// Client shim
// ============================================================

/** Minimal V2 context surface used by the adapter. */
interface V2ContextLike {
  location: {
    directory: string;
    project: { id: string; directory: string; canonical: string };
  };
  session: { get: (input: { sessionID: string }) => Promise<unknown> };
}

/** Build a V1-compatible `client` shim backed by the V2 context. */
export const createClientShim = (ctx: V2ContextLike): OpenCodeClient => {
  const client: OpenCodeClient = {
    session: {
      get: async (input: unknown) => {
        const record = input as { sessionID?: string; path?: { id?: string } } | undefined;
        const sessionID = record?.sessionID ?? record?.path?.id;
        if (!sessionID) {
          throw new Error('session.get: sessionID is required');
        }
        return (await ctx.session.get({ sessionID })) as SessionGetResult;
      },
    },
    tui: {
      // OpenCode V2 does not expose a plugin-facing toast API.  Keep the method
      // present so the shared notification code takes its toast path without
      // throwing; the call is intentionally a no-op.
      showToast: async () => undefined,
    },
  };
  return client;
};

// ============================================================
// Event translation (V2 -> V1)
// ============================================================

/**
 * Translate a V2 event envelope into the V1 `{ type, properties }` shape the
 * existing handler understands.  Returns `null` for events we do not consume.
 */
export const translateV2Event = (event: V2EventEnvelope): PluginEvent | null => {
  const data = event.data ?? {};

  switch (event.type) {
    case 'session.idle':
      return { type: 'session.idle', properties: { sessionID: data.sessionID as string } };

    case 'session.created':
      return {
        type: 'session.created',
        properties: {
          sessionID: data.sessionID as string,
          info: { id: data.sessionID as string },
        },
      };

    case 'session.execution.failed':
      return {
        type: 'session.error',
        properties: { sessionID: data.sessionID as string, error: data.error },
      };

    case 'permission.asked':
      // v2 permission shape — the handler flushes these immediately.
      return {
        type: 'permission.v2.asked',
        properties: {
          id: data.id as string,
          sessionID: data.sessionID as string,
          action: data.action as string,
          resources: data.resources as Array<string>,
          save: data.save as Array<string> | undefined,
          metadata: data.metadata as Record<string, unknown> | undefined,
          source: data.source as string | undefined,
        },
      };

    case 'permission.replied':
      return {
        type: 'permission.replied',
        properties: {
          sessionID: data.sessionID as string,
          requestID: data.requestID as string,
          reply: data.reply as string,
        },
      };

    case 'form.created': {
      const form = (data.form ?? {}) as { id?: string; sessionID?: string; fields?: Array<unknown> };
      return {
        type: 'question.v2.asked',
        properties: {
          id: form.id as string,
          sessionID: form.sessionID as string,
          questions: form.fields,
        },
      };
    }

    case 'form.replied':
      return {
        type: 'question.v2.replied',
        properties: {
          sessionID: data.sessionID as string,
          requestID: data.id as string,
          answers: data.answer as Array<Array<string>> | Array<unknown> | undefined,
        },
      };

    case 'form.cancelled':
      return {
        type: 'question.v2.rejected',
        properties: {
          sessionID: data.sessionID as string,
          requestID: data.id as string,
        },
      };

    case 'session.inbox.enqueued': {
      // User prompts are inbox items in V2.  Treat a user inbox item as the
      // equivalent of the V1 `message.updated` user-activity signal so pending
      // reminders are cancelled when the user responds.
      const item = (data.item ?? {}) as { type?: string };
      if (item.type !== 'user') {
        return null;
      }
      return {
        type: 'message.updated',
        properties: {
          sessionID: data.sessionID as string,
          info: {
            id: (data.inboxID as string) ?? `user-${Date.now()}`,
            role: 'user',
            // V1 compares message time (seconds) against idle time (ms).
            time: { created: Math.floor(Date.now() / 1000) },
          },
        },
      };
    }

    default:
      return null;
  }
};

// ============================================================
// V2 plugin definition
// ============================================================

/** V2 plugin instance created via `Plugin.define`. */
export const smartVoiceNotifyV2: Plugin.Plugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const shell = createShellRunner();
    const client = createClientShim(ctx as unknown as V2ContextLike);

    const directory = ctx.location.directory;
    const project = {
      id: ctx.location.project?.id,
      directory: ctx.location.project?.directory ?? directory,
      worktree: directory,
    };

    // Reuse the entire V1 notification engine by invoking it with shimmed
    // inputs.  The returned handlers expose `event` and `dispose`.
    const handlers = await SmartVoiceNotifyPlugin({
      project,
      client,
      $: shell,
      directory,
      worktree: directory,
    });

    const abort = new AbortController();
    let disposed = false;

    // Normalise the instance's own location once so event envelopes can be
    // matched regardless of trailing-slash / relative-path differences.
    const ownDirectory = resolvePath(directory);

    const eventTask = (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: abort.signal })) {
          if (disposed) break;
          const envelope = raw as unknown as V2EventEnvelope;
          // OpenCode V2 loads this plugin once per location while all instances
          // share one process-wide event stream.  Ignore events that belong to a
          // different location so each notification is handled by the instance
          // for the location it actually happened in (preserving per-project
          // names and sounds).
          const eventDirectory = envelope.location?.directory;
          if (eventDirectory && resolvePath(eventDirectory) !== ownDirectory) continue;
          // Safety net for events that carry no location (or for two instances
          // that share a directory): let only the first observer handle it so
          // audio is never played once per loaded location.
          const eventKey = envelope.id ?? (envelope.created !== undefined ? `${envelope.type}:${envelope.created}` : undefined);
          if (isDuplicateEvent(eventKey)) continue;
          const translated = translateV2Event(envelope);
          if (!translated) continue;
          try {
            await handlers.event?.({ event: translated });
          } catch {
            // The V1 handler already logs internally; never let one bad event
            // tear down the subscription.
          }
        }
      } catch {
        // Subscription ended (server shutdown / abort).  Nothing to do.
      }
    })();

    // V2 cleanup hook: stop consuming events and run the V1 dispose routine.
    return async () => {
      disposed = true;
      abort.abort();
      try {
        await eventTask;
      } catch {
        // ignore
      }
      try {
        await handlers.dispose?.();
      } catch {
        // ignore
      }
    };
  },
});
