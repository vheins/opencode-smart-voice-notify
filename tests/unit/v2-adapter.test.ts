import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import the BUILT package entry point (dist/index.js) exactly as OpenCode would.
import pkg, { SmartVoiceNotifyPlugin, translateV2Event, createShellRunner, createClientShim, isDuplicateEvent, rememberSessionLocation, getSessionLocation, PLUGIN_ID } from '../../dist/index.js';

describe('V2 package entry (dist/index.js)', () => {
  test('default export is a V2 definition object with id + setup', () => {
    expect(typeof pkg).toBe('object');
    expect(typeof pkg.id).toBe('string');
    expect(pkg.id.length).toBeGreaterThan(0);
    expect(typeof pkg.setup).toBe('function');
  });

  test('default export also carries the V1 server field', () => {
    expect(typeof pkg.server).toBe('function');
    expect(pkg.server).toBe(SmartVoiceNotifyPlugin);
  });

  test('named V1 export is still callable', () => {
    expect(typeof SmartVoiceNotifyPlugin).toBe('function');
  });

  test('PLUGIN_ID is stable', () => {
    expect(PLUGIN_ID).toBe('smart-voice-notify');
  });
});

describe('V2 event translation', () => {
  test('session.idle -> session.idle', () => {
    expect(translateV2Event({ type: 'session.idle', data: { sessionID: 'ses_1' } })).toEqual({
      type: 'session.idle',
      properties: { sessionID: 'ses_1' },
    });
  });

  test('session.created -> session.created with info.id', () => {
    const out = translateV2Event({ type: 'session.created', data: { sessionID: 'ses_2' } });
    expect(out?.type).toBe('session.created');
    expect(out?.properties?.info).toEqual({ id: 'ses_2' });
  });

  test('session.execution.succeeded -> session.idle (agent finished)', () => {
    expect(translateV2Event({ type: 'session.execution.succeeded', data: { sessionID: 'ses_done' } })).toEqual({
      type: 'session.idle',
      properties: { sessionID: 'ses_done' },
    });
  });

  test('session.execution.failed -> session.error', () => {
    const out = translateV2Event({ type: 'session.execution.failed', data: { sessionID: 'ses_3', error: { message: 'boom' } } });
    expect(out?.type).toBe('session.error');
    expect(out?.properties?.sessionID).toBe('ses_3');
    expect(out?.properties?.error).toEqual({ message: 'boom' });
  });

  test('permission.asked -> permission.v2.asked', () => {
    const out = translateV2Event({
      type: 'permission.asked',
      data: { id: 'perm_1', sessionID: 'ses_4', action: 'file.write', resources: ['/tmp/a'], save: ['/tmp/a'], source: { type: 'tool' } },
    });
    expect(out?.type).toBe('permission.v2.asked');
    expect(out?.properties?.id).toBe('perm_1');
    expect(out?.properties?.resources).toEqual(['/tmp/a']);
  });

  test('permission.replied -> permission.replied with requestID', () => {
    const out = translateV2Event({ type: 'permission.replied', data: { sessionID: 'ses_5', requestID: 'perm_1', reply: 'once' } });
    expect(out?.type).toBe('permission.replied');
    expect(out?.properties?.requestID).toBe('perm_1');
    expect(out?.properties?.reply).toBe('once');
  });

  test('form.created -> question.v2.asked', () => {
    const out = translateV2Event({
      type: 'form.created',
      data: { form: { id: 'form_1', sessionID: 'ses_6', title: 'Q', fields: [{ id: 'f1' }] } },
    });
    expect(out?.type).toBe('question.v2.asked');
    expect(out?.properties?.id).toBe('form_1');
    expect(out?.properties?.questions).toEqual([{ id: 'f1' }]);
  });

  test('form.replied -> question.v2.replied', () => {
    const out = translateV2Event({ type: 'form.replied', data: { id: 'form_1', sessionID: 'ses_7', answer: { f1: 'yes' } } });
    expect(out?.type).toBe('question.v2.replied');
    expect(out?.properties?.requestID).toBe('form_1');
  });

  test('form.cancelled -> question.v2.rejected', () => {
    const out = translateV2Event({ type: 'form.cancelled', data: { id: 'form_2', sessionID: 'ses_8' } });
    expect(out?.type).toBe('question.v2.rejected');
    expect(out?.properties?.requestID).toBe('form_2');
  });

  test('session.inbox.enqueued (user) -> message.updated user activity', () => {
    const out = translateV2Event({
      type: 'session.inbox.enqueued',
      data: { sessionID: 'ses_9', inboxID: 'inbox_1', item: { type: 'user', payload: { text: 'hi' } } },
    });
    expect(out?.type).toBe('message.updated');
    const info = out?.properties?.info as { id?: string; role?: string };
    expect(info?.role).toBe('user');
    expect(info?.id).toBe('inbox_1');
  });

  test('session.inbox.enqueued (non-user) is ignored', () => {
    expect(translateV2Event({ type: 'session.inbox.enqueued', data: { item: { type: 'synthetic' } } })).toBeNull();
  });

  test('unrelated events are ignored', () => {
    expect(translateV2Event({ type: 'provider.updated', data: {} })).toBeNull();
  });
});

describe('V2 shell runner shim', () => {
  test('runs a simple command and captures stdout', async () => {
    const $ = createShellRunner();
    const result = await $`printf 'hello'`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('hello');
  });

  test('interpolated values are passed as a single argument', async () => {
    const $ = createShellRunner();
    const value = 'a b c';
    const result = await $`printf '%s' ${value}`.quiet().nothrow();
    expect(result.stdout.toString()).toBe('a b c');
  });

  test('nothrow resolves with non-zero exit code instead of rejecting', async () => {
    const $ = createShellRunner();
    const result = await $`exit 7`.quiet().nothrow();
    expect(result.exitCode).toBe(7);
  });

  test('rejects on non-zero exit unless nothrow() is used', async () => {
    const $ = createShellRunner();
    let threw = false;
    try {
      await $`exit 3`.quiet();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('timeout() is chainable and kills a long-running command', async () => {
    const $ = createShellRunner();
    const result = await $`sleep 10`.quiet().nothrow().timeout!(150);
    expect(result.exitCode).toBe(124);
  });
});

describe('V2 client shim', () => {
  test('session.get maps to ctx.session.get', async () => {
    const calls: Array<unknown> = [];
    const ctx = {
      location: { directory: '/tmp/proj', project: { id: 'p1', directory: '/tmp/proj', canonical: '/tmp/proj' } },
      session: {
        get: async (input: { sessionID: string }) => {
          calls.push(input);
          return { id: input.sessionID };
        },
      },
    };
    const client = createClientShim(ctx);
    const session = await client.session.get({ path: { id: 'ses_42' } });
    expect(calls).toEqual([{ sessionID: 'ses_42' }]);
    expect((session as { id?: string }).id).toBe('ses_42');
  });

  test('tui.showToast is a safe no-op', async () => {
    const ctx = {
      location: { directory: '/tmp/proj', project: { id: 'p1', directory: '/tmp/proj', canonical: '/tmp/proj' } },
      session: { get: async () => ({ id: 'x' }) },
    };
    const client = createClientShim(ctx);
    await expect(client.tui?.showToast({ message: 'hi' })).resolves.toBeUndefined();
  });
});

describe('V2 setup() wiring', () => {
  test('subscribes to events and dispatches translated events to the V1 handler', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svn-v2-'));
    process.env.OPENCODE_CONFIG_DIR = tmp;

    // Minimal config: disabled so setup() does no audio/network work.
    fs.writeFileSync(path.join(tmp, 'smart-voice-notify.jsonc'), JSON.stringify({ enabled: false }));

    let unsubscribed = false;
    const seen: Array<string> = [];

    // A fake async-iterable event stream that yields one event then ends.
    const ctx = {
      location: { directory: tmp, project: { id: 'p1', directory: tmp, canonical: tmp } },
      options: {},
      session: { get: async () => ({ id: 'ses_1' }) },
      event: {
        subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
          [Symbol.asyncIterator]: () => {
            let done = false;
            return {
              next: async () => {
                if (done || signal?.aborted) return { done: true, value: undefined };
                done = true;
                seen.push('yielded');
                return { done: false, value: { type: 'session.idle', data: { sessionID: 'ses_1' } } };
              },
            };
          },
        }),
      },
    };

    const cleanup = await pkg.setup(ctx as never);
    expect(typeof cleanup).toBe('function');
    // Give the subscription loop a tick to consume the event.
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toContain('yielded');

    await cleanup?.();
    unsubscribed = true;
    expect(unsubscribed).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.OPENCODE_CONFIG_DIR;
  });
});

describe('V2 cross-instance event de-duplication', () => {
  test('first sighting of an event id is not a duplicate', () => {
    expect(isDuplicateEvent(`evt-${Math.random()}`)).toBe(false);
  });

  test('the same event id seen twice is a duplicate', () => {
    const id = `evt-${Math.random()}`;
    expect(isDuplicateEvent(id)).toBe(false);
    expect(isDuplicateEvent(id)).toBe(true);
    expect(isDuplicateEvent(id)).toBe(true);
  });

  test('distinct event ids are both handled', () => {
    const a = `evt-a-${Math.random()}`;
    const b = `evt-b-${Math.random()}`;
    expect(isDuplicateEvent(a)).toBe(false);
    expect(isDuplicateEvent(b)).toBe(false);
  });

  test('an event without an id is never treated as a duplicate', () => {
    expect(isDuplicateEvent(undefined)).toBe(false);
    expect(isDuplicateEvent(undefined)).toBe(false);
  });

  test('two plugin instances share the process-wide registry (only one handles the event)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svn-v2-dup-'));
    process.env.OPENCODE_CONFIG_DIR = tmp;
    fs.writeFileSync(path.join(tmp, 'smart-voice-notify.jsonc'), JSON.stringify({ enabled: false }));

    const makeCtx = (eventId: string) => ({
      location: { directory: tmp, project: { id: 'p1', directory: tmp, canonical: tmp } },
      options: {},
      session: { get: async () => ({ id: 'ses_1' }) },
      event: {
        subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
          [Symbol.asyncIterator]: () => {
            let done = false;
            return {
              next: async () => {
                if (done || signal?.aborted) return { done: true, value: undefined };
                done = true;
                return { done: false, value: { id: eventId, type: 'session.idle', data: { sessionID: 'ses_1' } } };
              },
            };
          },
        }),
      },
    });

    // Simulate the same event id being delivered to two independently loaded
    // plugin instances (as OpenCode does, once per location).
    const eventId = `evt-shared-${Math.random()}`;
    const first = isDuplicateEvent(eventId);
    const second = isDuplicateEvent(eventId);

    expect(first).toBe(false);
    expect(second).toBe(true);

    // And the full setup() path still works with the shared registry.
    const cleanupA = await pkg.setup(makeCtx(eventId) as never);
    const cleanupB = await pkg.setup(makeCtx(eventId) as never);
    await new Promise((r) => setTimeout(r, 50));
    await cleanupA?.();
    await cleanupB?.();

    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.OPENCODE_CONFIG_DIR;
  });

  test('events for another location are ignored by this instance', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svn-v2-loc-'));
    process.env.OPENCODE_CONFIG_DIR = tmp;
    fs.writeFileSync(path.join(tmp, 'smart-voice-notify.jsonc'), JSON.stringify({ enabled: false }));

    const seen: Array<string> = [];
    const makeCtx = (events: Array<Record<string, unknown>>) => ({
      location: { directory: tmp, project: { id: 'p1', directory: tmp, canonical: tmp } },
      options: {},
      session: { get: async () => ({ id: 'ses_1' }) },
      event: {
        subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
          [Symbol.asyncIterator]: () => {
            let i = 0;
            return {
              next: async () => {
                if (i >= events.length || signal?.aborted) return { done: true, value: undefined };
                const value = events[i++]!;
                seen.push(String(value.type));
                return { done: false, value };
              },
            };
          },
        }),
      },
    });

    const cleanup = await pkg.setup(
      makeCtx([
        { id: 'e-other', type: 'session.idle', location: { directory: '/some/other/location' }, data: { sessionID: 'ses_x' } },
        { id: 'e-own', type: 'session.idle', location: { directory: tmp }, data: { sessionID: 'ses_1' } },
      ]) as never,
    );
    await new Promise((r) => setTimeout(r, 50));
    await cleanup?.();

    // Both events reach the subscription, but the foreign one must not have
    // been processed (it would otherwise play audio for another project).
    expect(seen).toContain('session.idle');

    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.OPENCODE_CONFIG_DIR;
  });

  test('session location registry remembers and expires per-session directories', () => {
    const id = `ses-${Math.random()}`;
    expect(getSessionLocation(id)).toBeUndefined();
    rememberSessionLocation(id, '/tmp/foo');
    expect(getSessionLocation(id)).toBe('/tmp/foo');
    expect(getSessionLocation(undefined)).toBeUndefined();
  });

  test('a location-less execution.succeeded is routed via the remembered session location', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svn-v2-route-'));
    process.env.OPENCODE_CONFIG_DIR = tmp;
    fs.writeFileSync(path.join(tmp, 'smart-voice-notify.jsonc'), JSON.stringify({ enabled: false }));

    const sessionID = `ses-route-${Math.random()}`;
    const events = [
      // session.created carries a location -> registers the session
      { id: 'r-created', type: 'session.created', location: { directory: tmp }, data: { sessionID } },
      // execution.succeeded carries NO location -> must route via the registry
      { id: 'r-done', type: 'session.execution.succeeded', data: { sessionID } },
    ];

    const makeCtx = () => ({
      location: { directory: tmp, project: { id: 'p1', directory: tmp, canonical: tmp } },
      options: {},
      session: { get: async () => ({ id: sessionID }) },
      event: {
        subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
          [Symbol.asyncIterator]: () => {
            let i = 0;
            return {
              next: async () => {
                if (i >= events.length || signal?.aborted) return { done: true, value: undefined };
                return { done: false, value: events[i++]! };
              },
            };
          },
        }),
      },
    });

    const cleanup = await pkg.setup(makeCtx() as never);
    await new Promise((r) => setTimeout(r, 50));
    await cleanup?.();

    expect(getSessionLocation(sessionID)).toBe(tmp);

    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.OPENCODE_CONFIG_DIR;
  });
});
