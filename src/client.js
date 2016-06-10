'use strict'

/* global require:false, fetch:false, Request:false */

const msgr = require('msgr')
const shortid = require('shortid')
const defer = require('mini-defer')
const register = require('sw-register')
const serialiseRequest = require('serialise-request')
const serialiseResponse = require('serialise-response')

const { INIT, SYNC_RESULT, REGISTER_SYNC,
  CANCEL_SYNC, CANCEL_ALL_SYNCS } = require('./Messages')

const ready = defer()
const syncs = []

let channel = null
let hasStartedInit = false
let hasBackgroundSyncSupport = true
let serviceWorker = navigator.serviceWorker.controller

/**
 * Start a channel with the worker. Wrapped so that we can delay
 * execution until we know we have a worker that controls the page.
 */
const openCommsChannel = () => msgr(serviceWorker, {
  [INIT]: (event) => {
    const data = event.data.map(createSync, false)
    syncs.push(...data)
    ready.resolve()
  },
  [SYNC_RESULT]: (event) => {
    const data = JSON.parse(event.data)
    const sync = syncs[data.id]
    if (sync) {
      const response = serialiseResponse.deserialise(data.response)
      sync.resolve(response)
      if (sync.name) {
        sync.response = response
      }
    }
  }
})

function createSync (obj, isNew = true) {
  const sync = Object.assign({}, obj, defer())

  if (isNew) {
    Object.assign(sync, {
      createdOn: Date.now(),
      syncedOn: null,
      response: null,
      id: sync.name || shortid.generate()
    })
  } else {
    sync.response = sync.response
      ? serialiseResponse.deserialise(sync.response)
      : null
  }

  Object.assign(sync.promise, {
    name: sync.name,
    id: sync.id,
    createdOn: sync.createdOn,
    syncedOn: sync.syncedOn,
    getResponse: () => sync.response,
    cancel () {
      if (!sync.cancelled) {
        sync.cancelled = true
        return channel.send(CANCEL_SYNC, sync)
      }
      return Promise.reject(new Error('Sync already cancelled'))
    }
  })

  return sync
}

// ---
// Public
// ---

/**
 * Create a 'sync' operation.
 * @param {String|Request} [name]
 * @param {Object|String|Request} request
 * @param {Object} [options]
 * @returns {Promise}
 */
export default function fetchSync (name, request, options) {
  if (typeof options === 'undefined') {
    request = name
    options = request
  }

  if (typeof request !== 'string' && !(request instanceof Request)) {
    throw new Error('Expecting URL to be a string or Request')
  } else if (options && typeof options !== 'object') {
    throw new Error('Expecting options to be an object')
  }

  if (hasBackgroundSyncSupport)
    return serialiseRequest(request)
      .then((request) => createSync({ name, request, options }))
      .then((sync) => {
        syncs.push(sync)
        return channel.send(REGISTER_SYNC, sync)
      })
      .then((sync) => sync.promise)

  return fetch(request, options)
}

/**
 * Initialise fetchSync.
 * @param {Object} options
*/
fetchSync.init =
function fetchSync_init (options = null) {
  if (hasStartedInit) {
    throw new Error('fetchSync.init() called multiple times')
  } else if (options && !options.workerUrl) {
    throw new Error('Expecting `workerUrl` in options object')
  }

  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
    hasBackgroundSyncSupport = false
    return Promise.reject(new Error('Environment not supported'))
  }

  hasStartedInit = true

  return Promise.resolve()
    .then(() => register(options))
    .then(() => openCommsChannel())
    .then(() => ready.promise, (err) => {
      hasStartedInit = false
      console.warn('fetchSync initialisation failed: ' + err.message)
      throw err
    })
}

/**
 * Get a sync.
 * @param {String} name
 * @returns {Object|Boolean}
 */
fetchSync.get =
function fetchSync_get (name) {
  const sync = syncs.find((sync) => sync.name === name)
  return sync ? syncs.promise : Promise.reject(new Error('Sync not found'))
}

/**
 * Get all named syncs.
 * @returns {Array}
 */
fetchSync.getAll =
function fetchSync_getAll () {
  return syncs.filter(sync => !!sync.name)
}

/**
 * Cancel a sync.
 * @param {Object|String} sync
 * @returns {Promise}
 */
fetchSync.cancel =
function fetchSync_cancel (sync) {
  return fetchSync
    .get(typeof sync === 'object' ? sync.id : sync)
    .then((sync) => sync.cancel())
}

/**
 * Cancel all syncs.
 * @returns {Promise}
 */
fetchSync.cancelAll =
function fetchSync_cancelAll () {
  return channel.send(CANCEL_ALL_SYNCS)
}

// Wrap each method (except `init`) in a function to check whether
// initialisation has been started and reject if it has not
Object.keys(fetchSync).forEach((methodName) => {
  if (methodName === 'init') return
  Object.defineProperty(fetchSync, methodName, {
    enumerable: true,
    value: (...args) => {
      if (!hasStartedInit)
        throw new Error('Initialise fetchSync by calling init()')
      return ready.promise.then(() => fetchSync[methodName](...args))
    }
  })
})
