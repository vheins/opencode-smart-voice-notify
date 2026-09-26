import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import the BUILT package entry point (dist/index.js) exactly as OpenCode would.
import pkg, { SmartVoiceNotifyPlugin, translateV2Event, createShellRunner, createClientShim, PLUGIN_ID } from '../../dist/index.js';

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
    const result = await $`sleep 10`.quiet().nothrow().timeout(150);
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
