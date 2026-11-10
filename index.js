/**
 * Host half of `dsh-session-rollback`.
 *
 * What it registers:
 *  - a pre-mutation file recorder on the filesystem intent waterfalls, so every
 *    path a file tool is about to change has its current content stored before
 *    the mutation, attributed to the Session and turn that produced it;
 *  - the `sessionRollback` service (`state`, `rollback`) published through
 *    `ctx.provide`, plus the two same-origin routes the browser half posts to
 *    (`POST /session-rollback/state`, `POST /session-rollback/rollback`);
 *  - per-Session cleanup of the captured content.
 *
 * Both the service and the routes are wired from one instance, and every
 * registration is effect-owned: unloading the plugin removes the listeners, the
 * routes, the service and the stored snapshots.
 *
 * @module dsh-session-rollback
 */
import path from 'node:path'

import { registerRollbackApi } from './host/api.js'
import { createRecorder } from './host/recorder.js'
import { createRollbackService, SERVICE_KEY } from './host/service.js'
import { createSnapshotStore } from './host/snapshots.js'

export const name = 'dsh-session-rollback'

/** The recorder needs a filesystem, the Session store and the Agent registry. */
export const inject = ['fs', 'sessions', 'agents']

/**
 * Resolve the Harness home that holds plugin-private state.
 * @returns {string}
 */
function dshHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.dsh')
}

/**
 * Resolve the directory this profile owns below the Harness home. Profiles may
 * share one home, and unloading one profile must not delete another's snapshots.
 * @returns {string}
 */
function snapshotRoot() {
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.length > 0
    ? process.env.DSH_PROFILE.replace(/[^A-Za-z0-9._-]+/g, '_')
    : 'default'
  return path.join(dshHome(), 'session-rollback', profile)
}

/**
 * Register the Host half.
 * @param {object} ctx Cordis context of this plugin
 * @param {object} [config] Loader row config (`maxFileBytes`, `maxTurnBytes`,
 *   `maxTurnFiles`, `maxSessionBytes`)
 */
export function apply(ctx, config = {}) {
  /** The Host logger is optional; console keeps a failure visible without it. */
  let logger = console
  try {
    if (ctx.logger !== undefined && ctx.logger !== null) logger = ctx.logger
  } catch {
    // keep console
  }
  // Snapshots live under the Harness home, never inside a user workspace.
  const store = createSnapshotStore({ root: snapshotRoot(), config, logger })

  /**
   * The one service instance of this plugin, shared by `ctx.provide` and the routes.
   * @type {object | undefined}
   */
  let service

  // The effect body runs immediately, so `service` exists before the browser-facing
  // Context below mounts and the routes always receive this exact instance.
  ctx.effect(() => {
    const recorder = createRecorder({ ctx, store, logger })
    service = createRollbackService({ ctx, store, recorder, logger })
    const disposers = [
      ctx.provide(SERVICE_KEY, service),
      // A closed Session takes its snapshots with it.
      ctx.on('session/disposed', (session) => {
        if (typeof session?.id !== 'string') return
        void store.forget(session.id).catch((error) => {
          logger.warn?.(`session-rollback: cannot remove the snapshots of session "${session.id}": ${error instanceof Error ? error.message : String(error)}`)
        })
      }),
    ]
    return async () => {
      for (const dispose of disposers) {
        try {
          await dispose()
        } catch {
          // best effort during unload
        }
      }
      recorder.dispose()
      await store.dispose()
    }
  }, 'session-rollback')

  // The routes need the two services that only exist once the composition mounts
  // them, so they are registered from a child Context that waits for both.
  if (typeof ctx.inject !== 'function') {
    logger.warn?.('session-rollback: ctx.inject is unavailable; the browser half cannot reach the rollback service')
    return
  }
  ctx.inject(['webServer', 'connection'], (child) => {
    registerRollbackApi({ ctx: child, service, logger })
  })
}
