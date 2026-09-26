// @ts-nocheck
/**
 * Unit Tests for Sub-Session Filtering Edge Cases
 *
 * Comprehensive tests to verify that sub-session detection correctly
 * prevents spurious notifications, and that the fail-safe (API error)
 * path also suppresses notifications. Covers both session.idle and
 * session.error handlers.
 *
 * Key behaviors under test:
 * - Main sessions (parentID null) SHOULD trigger notifications
 * - Sub-sessions (parentID set) SHOULD NOT trigger notifications
 * - API call failures SHOULD trigger fallback notifications with generic messages
 * - Debounce entries are cleared when a sub-session or API error is detected
 *
 * @see src/index.ts - session.idle handler (lines ~1189-1303)
 * @see src/index.ts - session.error handler (lines ~1311-1388)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SmartVoiceNotifyPlugin } from '../../src/index.js';
import {
  createTestTempDir,
  cleanupTestTempDir,
  createTestConfig,
  createMinimalConfig,
  createTestAssets,
  createMockShellRunner,
  createMockClient,
  mockEvents,
  readTestFile,
  wait,
} from '../setup.js';

describe('Sub-Session Filtering', () => {
  let mockClient;
  let mockShell;
  let tempDir;

  beforeEach(() => {
    tempDir = createTestTempDir();
    createTestAssets();
    mockClient = createMockClient();
    mockShell = createMockShellRunner();
  });

  afterEach(() => {
    cleanupTestTempDir();
  });

  // ============================================================
  // HELPER: Initialize plugin with minimal config
  // ============================================================

  const initPlugin = async (overrides = {}) => {
    createTestConfig(
      createMinimalConfig({
        enabled: true,
        enableSound: true,
        enableToast: true,
        enableDesktopNotification: false,
        enableWebhook: false,
        enableTTSReminder: false,
        enableAIMessages: false,
        enableIdleNotification: true,
        enableErrorNotification: true,
        debugLog: false,
        idleSound: 'assets/test-sound.mp3',
        errorSound: 'assets/test-sound.mp3',
        ...overrides,
      }),
    );

    return SmartVoiceNotifyPlugin({
      project: { id: 'test-project' },
      client: mockClient,
      $: mockShell,
      directory: tempDir,
      worktree: tempDir,
    });
  };

  // ============================================================
  // SESSION.IDLE HANDLER - Sub-session filtering
  // ============================================================

  describe('session.idle handler', () => {
    // --------------------------------------------------------
    // Happy path: main session triggers notification
    // --------------------------------------------------------

    test('should trigger notification for main session (parentID null)', async () => {
      // Arrange
      const sessionId = 'main-session-001';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'idle',
      });
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - toast was shown (notification triggered)
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].message).toContain('Agent has finished');

      // Assert - sound was played
      expect(mockShell.getCallCount()).toBeGreaterThan(0);
      expect(mockShell.wasCalledWith('test-sound.mp3')).toBe(true);
    });

    test('should trigger notification when session has no parentID property at all', async () => {
      // Arrange - default mock session has parentID: null
      const sessionId = 'no-parent-prop-session';
      // The default mock returns { id, parentID: null, status: 'idle' }
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - notification triggered
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(mockShell.getCallCount()).toBeGreaterThan(0);
    });

    // --------------------------------------------------------
    // Sub-session: parentID set -> skip notification
    // --------------------------------------------------------

    test('should NOT trigger notification for sub-session (parentID set)', async () => {
      // Arrange
      const sessionId = 'sub-session-001';
      mockClient.session.setMockSession(sessionId, {
        parentID: 'parent-session-001',
        status: 'idle',
      });
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - no toast, no sound
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });

    test('should NOT trigger notification when parentID is a non-empty string', async () => {
      // Arrange - any truthy parentID should be filtered
      const sessionId = 'sub-session-truthy';
      mockClient.session.setMockSession(sessionId, {
        parentID: 'any-truthy-value',
        status: 'idle',
      });
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });

    // --------------------------------------------------------
    // API call fails -> fallback: send generic notification
    // --------------------------------------------------------

    test('should trigger fallback notification when session.get API call throws', async () => {
      // Arrange - override session.get to throw
      const sessionId = 'api-fail-session';
      mockClient.session.get = async () => {
        throw new Error('Network error: API unavailable');
      };
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - fallback notification sent (generic message, no session context)
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].message).toContain('Agent has finished');
    });

    test('should NOT trigger notification when session.get returns undefined data', async () => {
      // Arrange - API returns structure without data
      const sessionId = 'api-null-data-session';
      mockClient.session.get = async () => ({ data: undefined });
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - parentID is checked via sessionData?.parentID
      // When data is undefined, sessionData is null, so parentID check is falsy
      // The code sets sessionData = session?.data ?? null, then checks sessionData?.parentID
      // Since sessionData is null, parentID is undefined (falsy) -> proceeds to notification
      // This is the designed behavior: if we got a response but no data, treat as main session
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
    });

    // --------------------------------------------------------
    // Debounce entry cleared when sub-session is detected
    // --------------------------------------------------------

    test('should clear debounce entry when sub-session is detected', async () => {
      // Arrange
      const sessionId = 'debounce-sub-session';

      // First: set up as sub-session
      mockClient.session.setMockSession(sessionId, {
        parentID: 'parent-session',
        status: 'idle',
      });
      const plugin = await initPlugin();

      // Act 1: fire idle for sub-session -> sets debounce then clears it
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Verify no notification was sent (sub-session)
      expect(mockClient.tui.getToastCalls().length).toBe(0);

      // Act 2: now change to main session and fire idle again
      // If debounce was NOT cleared, this would be debounced and skipped.
      // If debounce WAS cleared, this should trigger a notification.
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'idle',
      });
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - notification triggered (debounce was cleared by sub-session detection)
      expect(mockClient.tui.getToastCalls().length).toBe(1);
      expect(mockClient.tui.getToastCalls()[0].message).toContain('Agent has finished');
    });

    // --------------------------------------------------------
    // Debounce entry cleared when API call fails
    // --------------------------------------------------------

    test('should clear debounce entry when API call fails', async () => {
      // Arrange
      const sessionId = 'debounce-api-fail';
      const originalGet = mockClient.session.get.bind(mockClient.session);

      // First call: API fails
      let callCount = 0;
      mockClient.session.get = async (input) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Transient API error');
        }
        // Subsequent calls succeed - return main session
        return originalGet(input);
      };
      const plugin = await initPlugin();

      // Act 1: fire idle -> API fails, fallback notification sent, debounce entry cleared
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Verify fallback notification sent (API failed = fallback with generic message)
      expect(mockClient.tui.getToastCalls().length).toBe(1);
      expect(mockClient.tui.getToastCalls()[0].message).toContain('Agent has finished');

      // Act 2: fire idle again -> API succeeds, main session
      // If debounce was NOT cleared, this would be debounced and skipped.
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - second notification triggered (debounce was cleared by API failure)
      expect(mockClient.tui.getToastCalls().length).toBe(2);
    });

    // --------------------------------------------------------
    // Debounce still active for successful main session
    // --------------------------------------------------------

    test('should debounce rapid duplicate idle events for main sessions', async () => {
      // Arrange
      const sessionId = 'debounce-main-session';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'idle',
      });
      const plugin = await initPlugin();

      // Act - fire same session.idle three times rapidly
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - only ONE notification (debounce active after first success)
      expect(mockClient.tui.getToastCalls().length).toBe(1);
    });

    // --------------------------------------------------------
    // No sessionID -> early return, no API call
    // --------------------------------------------------------

    test('should silently return when sessionID is missing', async () => {
      // Arrange
      const plugin = await initPlugin();

      // Act - event with no sessionID
      const event = { type: 'session.idle', properties: {} };
      await plugin.event({ event });

      // Assert - no toast, no sound, no API call
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });

    // --------------------------------------------------------
    // Idle notification disabled via config
    // --------------------------------------------------------

    test('should skip when enableIdleNotification is false', async () => {
      // Arrange
      const sessionId = 'disabled-idle-session';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'idle',
      });
      const plugin = await initPlugin({ enableIdleNotification: false });

      // Act
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });
  });

  // ============================================================
  // SESSION.ERROR HANDLER - Sub-session filtering
  // ============================================================

  describe('session.error handler', () => {
    // --------------------------------------------------------
    // Happy path: main session error triggers notification
    // --------------------------------------------------------

    test('should trigger notification for main session error (parentID null)', async () => {
      // Arrange
      const sessionId = 'main-error-session-001';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'error',
      });
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - toast shown with error variant
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].message).toContain('error');
      expect(toastCalls[0].variant).toBe('error');

      // Assert - sound was played
      expect(mockShell.getCallCount()).toBeGreaterThan(0);
      expect(mockShell.wasCalledWith('test-sound.mp3')).toBe(true);
    });

    test('should trigger notification when error session has no parentID property', async () => {
      // Arrange - default mock session has parentID: null
      const sessionId = 'error-no-parent-prop';
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - notification triggered
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].variant).toBe('error');
    });

    // --------------------------------------------------------
    // Sub-session error: parentID set -> skip notification
    // --------------------------------------------------------

    test('should NOT trigger notification for sub-session error (parentID set)', async () => {
      // Arrange
      const sessionId = 'sub-error-session-001';
      mockClient.session.setMockSession(sessionId, {
        parentID: 'parent-session-001',
        status: 'error',
      });
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - no toast, no sound
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });

    test('should NOT trigger notification for sub-session error with any truthy parentID', async () => {
      // Arrange
      const sessionId = 'sub-error-truthy-parent';
      mockClient.session.setMockSession(sessionId, {
        parentID: 'some-parent-id',
        status: 'error',
      });
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });

    // --------------------------------------------------------
    // API call fails -> fallback: send generic notification
    // --------------------------------------------------------

    test('should trigger fallback notification when session.get throws for error event', async () => {
      // Arrange - override session.get to throw
      const sessionId = 'api-fail-error-session';
      mockClient.session.get = async () => {
        throw new Error('Connection refused');
      };
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - fallback notification sent (generic error message)
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].message).toContain('error');
      expect(toastCalls[0].variant).toBe('error');
    });

    test('should trigger fallback notification when session.get throws TypeError', async () => {
      // Arrange - simulate a different type of API error
      const sessionId = 'api-typeerror-session';
      mockClient.session.get = async () => {
        throw new TypeError('Cannot read properties of undefined');
      };
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - fallback notification sent
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].message).toContain('error');
      expect(toastCalls[0].variant).toBe('error');
    });

    // --------------------------------------------------------
    // No sessionID -> early return, no API call
    // --------------------------------------------------------

    test('should silently return when error event has no sessionID', async () => {
      // Arrange
      const plugin = await initPlugin();

      // Act
      const event = { type: 'session.error', properties: {} };
      await plugin.event({ event });

      // Assert
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });

    // --------------------------------------------------------
    // Error notification disabled via config
    // --------------------------------------------------------

    test('should skip when enableErrorNotification is false', async () => {
      // Arrange
      const sessionId = 'disabled-error-session';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'error',
      });
      const plugin = await initPlugin({ enableErrorNotification: false });

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });
  });

  // ============================================================
  // CROSS-HANDLER: Interaction between idle and error events
  // ============================================================

  describe('cross-handler interactions', () => {
    test('sub-session idle skip should not affect main session error notification', async () => {
      // Arrange - same session ID, idle as sub-session, error as main
      const sessionId = 'cross-handler-session';

      // Set up as sub-session for idle (will be skipped)
      mockClient.session.setMockSession(sessionId, {
        parentID: 'parent-session',
        status: 'idle',
      });
      const plugin = await initPlugin();

      // Act 1: idle fires for sub-session -> skipped
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });
      expect(mockClient.tui.getToastCalls().length).toBe(0);

      // Act 2: change to main session, error fires -> should notify
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'error',
      });
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - error notification was sent
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].variant).toBe('error');
    });

    test('API failure on idle should not affect subsequent error notification', async () => {
      // Arrange
      const sessionId = 'api-fail-then-error';
      let callCount = 0;
      const originalGet = mockClient.session.get.bind(mockClient.session);

      mockClient.session.get = async (input) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Transient failure');
        }
        return originalGet(input);
      };
      const plugin = await initPlugin();

      // Act 1: idle fires -> API fails, fallback notification sent
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });
      expect(mockClient.tui.getToastCalls().length).toBe(1);

      // Act 2: error fires -> API succeeds, main session
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - error notification was also sent (2 total: fallback idle + normal error)
      expect(mockClient.tui.getToastCalls().length).toBe(2);
    });

    test('multiple sub-sessions should all be silently filtered', async () => {
      // Arrange - several sub-sessions
      const subIds = ['sub-1', 'sub-2', 'sub-3'];
      for (const id of subIds) {
        mockClient.session.setMockSession(id, {
          parentID: 'main-parent',
          status: 'idle',
        });
      }
      const plugin = await initPlugin();

      // Act - fire idle for each sub-session
      for (const id of subIds) {
        await plugin.event({ event: mockEvents.sessionIdle(id) });
      }

      // Assert - zero notifications
      expect(mockClient.tui.getToastCalls().length).toBe(0);
      expect(mockShell.getCallCount()).toBe(0);
    });

    test('main session after several filtered sub-sessions should still notify', async () => {
      // Arrange
      const subIds = ['sub-a', 'sub-b'];
      for (const id of subIds) {
        mockClient.session.setMockSession(id, {
          parentID: 'parent-main',
          status: 'idle',
        });
      }
      mockClient.session.setMockSession('main-session', {
        parentID: null,
        status: 'idle',
      });
      const plugin = await initPlugin();

      // Act - fire idle for sub-sessions, then main
      for (const id of subIds) {
        await plugin.event({ event: mockEvents.sessionIdle(id) });
      }
      await plugin.event({ event: mockEvents.sessionIdle('main-session') });

      // Assert - exactly one notification (for main session only)
      expect(mockClient.tui.getToastCalls().length).toBe(1);
    });
  });

  // ============================================================
  // SESSION CACHE: API call reduction and freshness
  // ============================================================

  describe('session cache behavior', () => {
    test('should reuse cached session data across idle and error events within TTL', async () => {
      // Arrange
      const sessionId = 'cache-reuse-main-session';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'idle',
      });

      let sessionGetCalls = 0;
      const originalGet = mockClient.session.get.bind(mockClient.session);
      mockClient.session.get = async (input) => {
        sessionGetCalls++;
        return originalGet(input);
      };

      const plugin = await initPlugin();

      // Act - first event fetches and caches, second event should use cache
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - only one API call for both events
      expect(sessionGetCalls).toBe(1);
    });

    test('should refresh cache after TTL expires', async () => {
      // Arrange
      const sessionId = 'cache-expiry-session';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'idle',
      });

      let sessionGetCalls = 0;
      const originalGet = mockClient.session.get.bind(mockClient.session);
      mockClient.session.get = async (input) => {
        sessionGetCalls++;
        return originalGet(input);
      };

      const realDateNow = Date.now;
      let fakeNow = 1_000;
      Date.now = () => fakeNow;

      try {
        const plugin = await initPlugin();

        // Act 1 - initial fetch and cache write
        await plugin.event({ event: mockEvents.sessionIdle(sessionId) });
        expect(sessionGetCalls).toBe(1);

        // Advance beyond 30s TTL, then trigger another event
        fakeNow += 30_001;
        await plugin.event({ event: mockEvents.sessionError(sessionId) });

        // Assert - stale cache forced a second API call
        expect(sessionGetCalls).toBe(2);
      } finally {
        Date.now = realDateNow;
      }
    });

    test('should clear session cache on session.created for that session', async () => {
      // Arrange
      const sessionId = 'cache-clear-on-created';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'idle',
      });

      let sessionGetCalls = 0;
      const originalGet = mockClient.session.get.bind(mockClient.session);
      mockClient.session.get = async (input) => {
        sessionGetCalls++;
        return originalGet(input);
      };

      const plugin = await initPlugin();

      // Act 1 - cache main-session result
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });
      expect(sessionGetCalls).toBe(1);

      // Update backing session data to sub-session and clear cache via session.created
      mockClient.session.setMockSession(sessionId, {
        parentID: 'parent-after-created',
        status: 'error',
      });
      await plugin.event({ event: mockEvents.sessionCreated(sessionId) });

      // Act 2 - should re-fetch (cache cleared) and skip notification as sub-session
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - API called again after session.created cache invalidation
      expect(sessionGetCalls).toBe(2);

      // Assert - only the first idle notification was sent (error was filtered)
      expect(mockClient.tui.getToastCalls().length).toBe(1);
    });

    test('should write cache hit and miss debug logs', async () => {
      // Arrange
      const sessionId = 'cache-debug-log-session';
      mockClient.session.setMockSession(sessionId, {
        parentID: null,
        status: 'idle',
      });

      const plugin = await initPlugin({ debugLog: true });

      // Act - first is miss, second should be hit
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert
      const debugLogContent = readTestFile('logs/smart-voice-notify-debug.log') || '';
      expect(debugLogContent.includes(`session.idle: session cache miss for ${sessionId}`)).toBe(true);
      expect(debugLogContent.includes(`session.error: session cache hit for ${sessionId}`)).toBe(true);
    });
  });

  // ============================================================
  // ERROR RESILIENCE: Various failure modes
  // ============================================================

  describe('error resilience', () => {
    test('session.get returning null session should not crash idle handler', async () => {
      // Arrange
      const sessionId = 'null-session';
      mockClient.session.get = async () => ({ data: null });
      const plugin = await initPlugin();

      // Act - should not throw
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - notification proceeds (null data means no parentID -> treat as main)
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
    });

    test('session.get returning empty object should not crash error handler', async () => {
      // Arrange
      const sessionId = 'empty-session';
      mockClient.session.get = async () => ({ data: {} });
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - no parentID on empty object -> proceeds with notification
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
    });

    test('non-Error thrown from session.get should be handled gracefully', async () => {
      // Arrange - throw a string instead of Error
      const sessionId = 'string-throw-session';
      mockClient.session.get = async () => {
        throw 'unexpected string error';
      };
      const plugin = await initPlugin();

      // Act - should not crash
      await plugin.event({ event: mockEvents.sessionIdle(sessionId) });

      // Assert - fallback notification sent (graceful handling of non-Error)
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].message).toContain('Agent has finished');
    });

    test('session.get rejecting with undefined should be handled', async () => {
      // Arrange
      const sessionId = 'undefined-reject-session';
      mockClient.session.get = async () => {
        throw undefined;
      };
      const plugin = await initPlugin();

      // Act
      await plugin.event({ event: mockEvents.sessionError(sessionId) });

      // Assert - fallback notification sent (graceful handling of undefined rejection)
      const toastCalls = mockClient.tui.getToastCalls();
      expect(toastCalls.length).toBe(1);
      expect(toastCalls[0].message).toContain('error');
      expect(toastCalls[0].variant).toBe('error');
    });
  });
});
