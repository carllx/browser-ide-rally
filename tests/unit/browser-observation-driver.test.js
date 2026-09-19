import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRegistry } from '../../src/registry/project-registry.js';
import { BrowserObservationDriver } from '../../src/runtime/browser-observation-driver.js';

describe('BrowserObservationDriver', () => {
  let registry;
  let mockBrowserAdapter;
  let driver;

  beforeEach(() => {
    registry = createProjectRegistry();
  });

  afterEach(() => {
    if (driver && driver.isRunning()) {
      driver.stop();
    }
  });

  function setupProject(bindingId, browserConvId) {
    return registry.registerProject({
      binding: {
        binding_id: bindingId,
        binding_revision: 1,
        browser: {
          provider: 'chatgpt',
          conversation_id: browserConvId
        },
        ide_endpoints: [
          {
            endpoint_id: 'ide-primary',
            endpoint_revision: 1,
            conversation_id: `ide-conv-${bindingId}`,
            workspace_identity: `/ws/${bindingId}`,
            repository_identity: `user/${bindingId}`
          }
        ],
        capabilities: ['read', 'write'],
        paused: false
      }
    });
  }

  it('records completed browser observation and advances endpoint to NEW without touching IDE', async () => {
    const project = setupProject('proj-a', 'browser-conv-a');

    mockBrowserAdapter = {
      observeBrowserEndpoint: ({ conversationId }) => {
        if (conversationId === 'browser-conv-a') {
          return {
            conversation_id: 'browser-conv-a',
            trusted: true,
            latest_completed_cursor: 'cursor-turn-1',
            completed_at: '2026-09-19T10:00:00.000Z',
            is_generating: false,
            should_record: true,
            latest_completed_result: {
              cursor: 'cursor-turn-1',
              result_ref: 'res_turn1',
              text: 'Hello from ChatGPT',
              captured_at: '2026-09-19T10:00:00.000Z'
            }
          };
        }
        return { conversation_id: conversationId, trusted: false, continuity_lost: true };
      }
    };

    driver = new BrowserObservationDriver({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 1000
    });

    const result = await driver.pollOnce();
    assert.equal(result.recordedCount, 1);

    const snapshot = project.getSnapshot();
    assert.equal(snapshot.endpoints.browser.continuity.trusted, true);
    assert.equal(snapshot.endpoints.browser.latest_completed_cursor, 'cursor-turn-1');
    assert.equal(snapshot.endpoints.browser.result_state, 'NEW');

    // IDE endpoint remains untouched (UNKNOWN)
    assert.equal(snapshot.endpoints.ide_endpoints['ide-primary'].continuity.trusted, false);
    assert.equal(snapshot.endpoints.ide_endpoints['ide-primary'].result_state, 'UNKNOWN');
  });

  it('suppresses redundant recording when latest cursor and trust state are unchanged', async () => {
    const project = setupProject('proj-b', 'browser-conv-b');

    let observeCallCount = 0;
    mockBrowserAdapter = {
      observeBrowserEndpoint: () => {
        observeCallCount++;
        return {
          conversation_id: 'browser-conv-b',
          trusted: true,
          latest_completed_cursor: 'cursor-stable',
          completed_at: '2026-09-19T10:00:00.000Z',
          is_generating: false,
          should_record: true,
          latest_completed_result: {
            cursor: 'cursor-stable',
            result_ref: 'res_stable',
            text: 'Same text',
            captured_at: '2026-09-19T10:00:00.000Z'
          }
        };
      }
    };

    let recordCallCount = 0;
    const originalRecord = project.recordEndpointObservation.bind(project);
    project.recordEndpointObservation = (...args) => {
      recordCallCount++;
      return originalRecord(...args);
    };

    driver = new BrowserObservationDriver({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 1000
    });

    // First poll records observation and triggers core record
    const firstPoll = await driver.pollOnce();
    assert.equal(firstPoll.recordedCount, 1);
    assert.equal(recordCallCount, 1);

    // Second poll with identical state must suppress recording
    const secondPoll = await driver.pollOnce();
    assert.equal(secondPoll.recordedCount, 0);
    assert.equal(secondPoll.skippedCount, 1);
    assert.equal(recordCallCount, 1, 'Core record must not be called on identical observation');

    // Third poll also suppressed
    const thirdPoll = await driver.pollOnce();
    assert.equal(thirdPoll.recordedCount, 0);
    assert.equal(recordCallCount, 1);
  });

  it('suppresses recording when is_generating is true or should_record is false', async () => {
    const project = setupProject('proj-c', 'browser-conv-c');

    mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        conversation_id: 'browser-conv-c',
        trusted: false,
        is_generating: true,
        should_record: false,
        reason: 'generation_in_progress: ChatGPT is currently generating response'
      })
    };

    let recordCallCount = 0;
    project.recordEndpointObservation = () => {
      recordCallCount++;
    };

    driver = new BrowserObservationDriver({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 1000
    });

    const pollResult = await driver.pollOnce();
    assert.equal(pollResult.recordedCount, 0);
    assert.equal(pollResult.generatingCount, 1);
    assert.equal(recordCallCount, 0);

    const snapshot = project.getSnapshot();
    assert.equal(snapshot.endpoints.browser.continuity.trusted, false);
    assert.equal(snapshot.endpoints.browser.result_state, 'UNKNOWN');
  });

  it('ensures multi-project isolation: observing Project A does not affect Project B', async () => {
    const projectA = setupProject('proj-a', 'browser-conv-a');
    const projectB = setupProject('proj-b', 'browser-conv-b');

    mockBrowserAdapter = {
      observeBrowserEndpoint: ({ conversationId }) => {
        if (conversationId === 'browser-conv-a') {
          return {
            conversation_id: 'browser-conv-a',
            trusted: true,
            latest_completed_cursor: 'cursor-a-1',
            completed_at: '2026-09-19T10:00:00.000Z',
            is_generating: false,
            should_record: true,
            latest_completed_result: {
              cursor: 'cursor-a-1',
              result_ref: 'res_a_1',
              text: 'Project A result',
              captured_at: '2026-09-19T10:00:00.000Z'
            }
          };
        }
        // Project B has not completed anything new
        return {
          conversation_id: 'browser-conv-b',
          trusted: true,
          latest_completed_cursor: null,
          is_generating: false,
          should_record: true
        };
      }
    };

    driver = new BrowserObservationDriver({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 1000
    });

    await driver.pollOnce();

    const snapA = projectA.getSnapshot();
    const snapB = projectB.getSnapshot();

    assert.equal(snapA.endpoints.browser.latest_completed_cursor, 'cursor-a-1');
    assert.equal(snapA.endpoints.browser.result_state, 'NEW');

    assert.equal(snapB.endpoints.browser.latest_completed_cursor, null);
    assert.equal(snapB.endpoints.browser.result_state, 'NO_NEW_RESULT');
  });

  it('starts and stops cleanly without leaving active timers', async () => {
    mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        trusted: true,
        latest_completed_cursor: null,
        is_generating: false,
        should_record: true
      })
    };

    driver = new BrowserObservationDriver({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 50
    });

    assert.equal(driver.isRunning(), false);
    driver.start();
    assert.equal(driver.isRunning(), true);

    // Wait a brief tick
    await new Promise(r => setTimeout(r, 80));

    driver.stop();
    assert.equal(driver.isRunning(), false);
  });

  it('suppresses redundant recording when repeated observations remain untrusted / disconnected', async () => {
    const project = setupProject('proj-untrusted', 'browser-conv-untrusted');

    let recordCallCount = 0;
    const originalRecord = project.recordEndpointObservation.bind(project);
    project.recordEndpointObservation = (...args) => {
      recordCallCount++;
      return originalRecord(...args);
    };

    mockBrowserAdapter = {
      observeBrowserEndpoint: () => ({
        conversation_id: 'browser-conv-untrusted',
        trusted: false,
        continuity_lost: true,
        reason: 'tab_closed_or_not_found',
        latest_completed_cursor: null,
        is_generating: false,
        should_record: true
      })
    };

    driver = new BrowserObservationDriver({
      registry,
      browserAdapter: mockBrowserAdapter,
      pollIntervalMs: 1000
    });

    // 第一次轮询：从未观察过 -> 记录 UNKNOWN (recordCallCount = 1)
    const firstPoll = await driver.pollOnce();
    assert.equal(firstPoll.recordedCount, 1);
    assert.equal(recordCallCount, 1);

    // 第二次轮询：依然是 tab_closed_or_not_found -> 防重写拦截，绝不反复重写磁盘！
    const secondPoll = await driver.pollOnce();
    assert.equal(secondPoll.recordedCount, 0);
    assert.equal(secondPoll.skippedCount, 1);
    assert.equal(recordCallCount, 1);

    // 第三次轮询：依然拦截
    const thirdPoll = await driver.pollOnce();
    assert.equal(thirdPoll.recordedCount, 0);
    assert.equal(recordCallCount, 1);
  });
});
