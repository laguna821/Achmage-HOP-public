/*! EventEmitter adapted from Node.js lib/events.js. Copyright Joyent, Inc. and other Node contributors. MIT License:
 * licenses/Node.js-v24.19.0-LICENSE.txt (the Node.js license, reproduced in THIRD_PARTY_NOTICES). */
'use strict';
// node:events EventEmitter for the WebView worker, used by readable-stream 2 (JSZip's nodeStream, through which
// Kordoc reads ZIP entries). Same listener order, once/prepend, removeListener and unhandled 'error' behaviour as Node.

function EventEmitter() { EventEmitter.init.call(this); }
EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;
EventEmitter.defaultMaxListeners = 10;
EventEmitter.init = function init() {
  if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
    this._events = Object.create(null);
    this._eventsCount = 0;
  }
  this._maxListeners = this._maxListeners || undefined;
};

function checkListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type Function. Received type ' + typeof listener);
}

EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) { this._maxListeners = n; return this; };
EventEmitter.prototype.getMaxListeners = function getMaxListeners() { return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners; };

EventEmitter.prototype.emit = function emit(type, ...args) {
  const events = this._events;
  if (type === 'error' && (events === undefined || events.error === undefined)) {
    const er = args[0];
    if (er instanceof Error) throw er;
    const err = new Error('Unhandled error.' + (er === undefined ? '' : ' (' + (typeof er === 'string' ? "'" + er + "'" : er) + ')'));
    err.context = er;
    throw err;
  }
  const handler = events === undefined ? undefined : events[type];
  if (handler === undefined) return false;
  if (typeof handler === 'function') Reflect.apply(handler, this, args);
  else for (const listener of handler.slice()) Reflect.apply(listener, this, args);
  return true;
};

function addListener(target, type, listener, prepend) {
  checkListener(listener);
  let events = target._events;
  if (events === undefined) {
    events = target._events = Object.create(null);
    target._eventsCount = 0;
  } else if (events.newListener !== undefined) {
    target.emit('newListener', type, listener.listener ? listener.listener : listener);
    events = target._events;
  }
  const existing = events[type];
  if (existing === undefined) {
    events[type] = listener;
    ++target._eventsCount;
  } else if (typeof existing === 'function') {
    events[type] = prepend ? [listener, existing] : [existing, listener];
  } else if (prepend) existing.unshift(listener);
  else existing.push(listener);
  return target;
}
EventEmitter.prototype.addListener = function (type, listener) { return addListener(this, type, listener, false); };
EventEmitter.prototype.on = EventEmitter.prototype.addListener;
EventEmitter.prototype.prependListener = function (type, listener) { return addListener(this, type, listener, true); };

function onceWrapper(target, type, listener) {
  const state = { fired: false, target, type, listener };
  const wrapped = function (...args) {
    if (state.fired) return undefined;
    state.target.removeListener(state.type, wrapped);
    state.fired = true;
    return Reflect.apply(state.listener, state.target, args);
  };
  wrapped.listener = listener;
  return wrapped;
}
EventEmitter.prototype.once = function once(type, listener) { checkListener(listener); this.on(type, onceWrapper(this, type, listener)); return this; };
EventEmitter.prototype.prependOnceListener = function (type, listener) { checkListener(listener); this.prependListener(type, onceWrapper(this, type, listener)); return this; };

EventEmitter.prototype.removeListener = function removeListener(type, listener) {
  checkListener(listener);
  const events = this._events;
  if (events === undefined) return this;
  const list = events[type];
  if (list === undefined) return this;
  if (list === listener || list.listener === listener) {
    if (--this._eventsCount === 0) this._events = Object.create(null);
    else {
      delete events[type];
      if (events.removeListener) this.emit('removeListener', type, list.listener || listener);
    }
  } else if (typeof list !== 'function') {
    let position = -1, original;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) { original = list[i].listener; position = i; break; }
    }
    if (position < 0) return this;
    list.splice(position, 1);
    if (list.length === 1) events[type] = list[0];
    if (events.removeListener !== undefined) this.emit('removeListener', type, original || listener);
  }
  return this;
};
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function removeAllListeners(type) {
  const events = this._events;
  if (events === undefined) return this;
  if (events.removeListener === undefined) {
    if (arguments.length === 0) { this._events = Object.create(null); this._eventsCount = 0; }
    else if (events[type] !== undefined) { if (--this._eventsCount === 0) this._events = Object.create(null); else delete events[type]; }
    return this;
  }
  if (arguments.length === 0) {
    for (const key of Reflect.ownKeys(events)) if (key !== 'removeListener') this.removeAllListeners(key);
    this.removeAllListeners('removeListener');
    this._events = Object.create(null);
    this._eventsCount = 0;
    return this;
  }
  const listeners = events[type];
  if (typeof listeners === 'function') this.removeListener(type, listeners);
  else if (listeners !== undefined) for (let i = listeners.length - 1; i >= 0; i--) this.removeListener(type, listeners[i]);
  return this;
};

function listeners(target, type, unwrap) {
  const events = target._events;
  if (events === undefined || events[type] === undefined) return [];
  const value = events[type];
  if (typeof value === 'function') return unwrap ? [value.listener || value] : [value];
  return unwrap ? value.map((l) => l.listener || l) : value.slice();
}
EventEmitter.prototype.listeners = function (type) { return listeners(this, type, true); };
EventEmitter.prototype.rawListeners = function (type) { return listeners(this, type, false); };
function listenerCount(type) {
  const events = this._events;
  if (events === undefined) return 0;
  const value = events[type];
  return typeof value === 'function' ? 1 : value === undefined ? 0 : value.length;
}
EventEmitter.prototype.listenerCount = listenerCount;
EventEmitter.listenerCount = (emitter, type) => (typeof emitter.listenerCount === 'function' ? emitter.listenerCount(type) : listenerCount.call(emitter, type));
EventEmitter.prototype.eventNames = function eventNames() { return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : []; };

module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;
