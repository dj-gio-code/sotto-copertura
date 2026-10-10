// Strato di comunicazione: un "database a percorsi" con due implementazioni.
//  - Firebase Realtime Database (se src/firebase-config.js è compilato)
//  - Modalità locale di prova (localStorage + evento "storage": funziona tra schede dello stesso browser)
//
// API (identica per entrambe):
//   now()                       ora "condivisa" in ms
//   get(path)                   Promise<valore|null>
//   set(path, valore)           valore null = cancella
//   update(path, patch)         unisce i campi di patch dentro path
//   remove(path)
//   listen(path, cb)            cb(valore|null) subito e a ogni cambiamento; ritorna unsubscribe
//   onDisconnectRemove(path)    cancella path quando la scheda si chiude

import { firebaseConfig } from './firebase-config.js'

const LS_KEY = 'sotto-copertura:db-locale'

const keysOf = (path) => path.split('/').filter(Boolean)
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)))

function getAt(root, path) {
  let n = root
  for (const k of keysOf(path)) {
    if (n == null || typeof n !== 'object') return null
    n = n[k]
  }
  return n === undefined ? null : n
}

function setAt(root, path, value) {
  const keys = keysOf(path)
  if (!keys.length) return
  const chain = [root]
  let n = root
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (n[k] == null || typeof n[k] !== 'object') {
      if (value == null) return // niente da cancellare
      n[k] = {}
    }
    n = n[k]
    chain.push(n)
  }
  const last = keys[keys.length - 1]
  if (value == null) {
    delete n[last]
    // come Firebase: i nodi rimasti vuoti spariscono
    for (let i = chain.length - 1; i > 0; i--) {
      if (Object.keys(chain[i]).length === 0) delete chain[i - 1][keys[i - 1]]
      else break
    }
  } else {
    n[last] = value
  }
}

function browserStorage() {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

function memoryStorage() {
  const m = {}
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      m[k] = String(v)
    },
  }
}

// ---------- Modalità locale ----------

export function createLocalBackend({ storage } = {}) {
  const store = storage || browserStorage() || memoryStorage()
  const listeners = new Set()
  const onDisconnect = new Set()
  let notifying = false
  let dirty = false

  const load = () => {
    try {
      return JSON.parse(store.getItem(LS_KEY) || '{}') || {}
    } catch {
      return {}
    }
  }
  const save = (root) => store.setItem(LS_KEY, JSON.stringify(root))

  function notify() {
    if (notifying) {
      dirty = true
      return
    }
    notifying = true
    try {
      do {
        dirty = false
        const root = load()
        for (const l of [...listeners]) {
          const v = getAt(root, l.path)
          const json = JSON.stringify(v ?? null)
          if (json !== l.last) {
            l.last = json
            l.cb(JSON.parse(json))
          }
        }
      } while (dirty)
    } finally {
      notifying = false
    }
  }

  function commit(fn) {
    const root = load()
    fn(root)
    save(root)
    notify()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === LS_KEY) notify()
    })
    window.addEventListener('pagehide', () => {
      if (onDisconnect.size) commit((root) => onDisconnect.forEach((p) => setAt(root, p, null)))
    })
  }

  return {
    kind: 'local',
    now: () => Date.now(),
    async get(path) {
      return clone(getAt(load(), path))
    },
    async set(path, value) {
      const v = clone(value)
      commit((r) => setAt(r, path, v))
    },
    async update(path, patch) {
      commit((r) => {
        for (const [k, v] of Object.entries(patch)) setAt(r, `${path}/${k}`, clone(v))
      })
    },
    async remove(path) {
      commit((r) => setAt(r, path, null))
    },
    listen(path, cb) {
      const l = { path, cb, last: null }
      listeners.add(l)
      const v = clone(getAt(load(), path))
      l.last = JSON.stringify(v)
      cb(v)
      return () => listeners.delete(l)
    },
    onDisconnectRemove(path) {
      onDisconnect.add(path)
    },
  }
}

// ---------- Firebase ----------

async function createFirebaseBackend(config) {
  const [{ initializeApp }, fb] = await Promise.all([import('firebase/app'), import('firebase/database')])
  const app = initializeApp(config)
  const database = fb.getDatabase(app)
  let offset = 0
  fb.onValue(fb.ref(database, '.info/serverTimeOffset'), (s) => {
    offset = s.val() || 0
  })
  const r = (path) => fb.ref(database, path)
  return {
    kind: 'firebase',
    now: () => Date.now() + offset,
    get: async (path) => (await fb.get(r(path))).val(),
    set: (path, value) => fb.set(r(path), value ?? null),
    update: (path, patch) => fb.update(r(path), patch),
    remove: (path) => fb.remove(r(path)),
    listen: (path, cb) => fb.onValue(r(path), (s) => cb(s.val())),
    onDisconnectRemove: (path) => fb.onDisconnect(r(path)).remove(),
  }
}

let backendPromise = null

export function getBackend() {
  if (!backendPromise) {
    const useFirebase = firebaseConfig && firebaseConfig.databaseURL
    backendPromise = useFirebase ? createFirebaseBackend(firebaseConfig) : Promise.resolve(createLocalBackend())
  }
  return backendPromise
}
