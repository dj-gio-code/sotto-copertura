// Logica della stanza e della partita (condivisa tramite il backend).
//
// Il "host" è il giocatore presente da più tempo: è lui che fa avanzare le fasi.
// Tutto lo stato vive nel database, quindi se l'host esce il prossimo prosegue da dove era.
//
// Percorsi sotto rooms/<codice>/:
//   players/<uid>  {name, photo, color, joinedAt}
//   pos/<uid>      {x, y, m}
//   state          {phase, seq, round, participants, turnOrder, turnIndex, deadline, ...}
//   secret         {impostor, word, category}
//   clues/<uid>    testo dell'indizio
//   votes/<uid>    uid votato
//   guess          tentativo finale dell'impostore

import { pickWord } from './words.js'

export const MIN_PLAYERS = 4
export const MAX_PLAYERS = 8
export const MIN_IN_GAME = 3

export const LEG_COLORS = ['#9aa0a6', '#e53935', '#8e44ad', '#e91e8c', '#fdd835', '#43a047']

export const DEFAULT_TIMERS = {
  clue: 30000, // turno per scrivere l'indizio
  discuss: 60000, // discussione libera
  vote: 30000, // votazione
  guess: 25000, // tentativo finale dell'impostore scoperto
  grace: 8000, // tolleranza prima di annullare per uscite (refresh)
}

export const toArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}))

export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function createSession({ backend, code, me, onChange = () => {}, timers = {} }) {
  const T = { ...DEFAULT_TIMERS, ...timers }
  const base = `rooms/${code}`
  const data = { players: {}, pos: {}, state: null, secret: null, clues: {}, votes: {}, guess: null }
  const unsubs = []
  const grace = { since: null }
  let joined = false
  let starting = false
  let tickTimer = null

  const changed = () => onChange(data)

  const playerList = () =>
    Object.entries(data.players)
      .map(([uid, p]) => ({ uid, ...p }))
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.uid < b.uid ? -1 : 1))
  const hostUid = () => playerList()[0]?.uid ?? null
  const isHost = () => joined && hostUid() === me.uid

  const patchState = (patch) =>
    backend.update(`${base}/state`, { ...patch, seq: (data.state?.seq || 0) + 1 })

  // ---------- Ingresso / uscita ----------

  async function join() {
    const [players, state] = await Promise.all([
      backend.get(`${base}/players`),
      backend.get(`${base}/state`),
    ])
    const present = players || {}
    const already = !!present[me.uid]
    if (!already) {
      if (Object.keys(present).length >= MAX_PLAYERS) return { ok: false, reason: 'full' }
      const member = toArray(state?.participants).includes(me.uid)
      if (state && state.phase !== 'lobby' && !member) return { ok: false, reason: 'running' }
    }

    const used = new Set(Object.values(present).map((p) => p.color))
    const free = LEG_COLORS.filter((c) => !used.has(c))
    const color = pick(free.length ? free : LEG_COLORS)
    const slot = Object.keys(present).length

    await backend.set(`${base}/players/${me.uid}`, {
      name: me.name,
      photo: me.photo || null,
      color,
      joinedAt: backend.now(),
    })
    backend.onDisconnectRemove(`${base}/players/${me.uid}`)
    backend.onDisconnectRemove(`${base}/pos/${me.uid}`)

    const angle = (slot / MAX_PLAYERS) * Math.PI * 2 - Math.PI / 2
    await backend.set(`${base}/pos/${me.uid}`, { x: Math.cos(angle) * 0.5, y: Math.sin(angle) * 0.5, m: 0 })
    if (!state) await backend.set(`${base}/state`, { phase: 'lobby', seq: 0, round: 0 })

    const watch = (key, path, fallback, notify = true) =>
      unsubs.push(
        backend.listen(`${base}/${path}`, (v) => {
          data[key] = v ?? fallback
          if (notify) changed()
        })
      )
    watch('players', 'players', {})
    watch('pos', 'pos', {}, false)
    watch('state', 'state', null)
    watch('secret', 'secret', null)
    watch('clues', 'clues', {})
    watch('votes', 'votes', {})
    watch('guess', 'guess', null)

    joined = true
    tickTimer = setInterval(tick, 500)
    changed()
    return { ok: true }
  }

  function leave() {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
    unsubs.splice(0).forEach((u) => u && u())
    if (joined) {
      joined = false
      backend.remove(`${base}/players/${me.uid}`)
      backend.remove(`${base}/pos/${me.uid}`)
    }
  }

  // ---------- Azioni del giocatore ----------

  function setPos(x, y, m) {
    if (!joined) return
    backend.set(`${base}/pos/${me.uid}`, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, m: m ? 1 : 0 })
  }

  function submitClue(text) {
    const st = data.state
    if (!joined || st?.phase !== 'clues') return false
    if (toArray(st.turnOrder)[st.turnIndex] !== me.uid) return false
    const t = clean(text, 60) // l'indizio può essere una frase breve
    if (!t) return false
    backend.set(`${base}/clues/${me.uid}`, t)
    return true
  }

  function vote(targetUid) {
    const st = data.state
    if (!joined || st?.phase !== 'voting') return false
    const parts = toArray(st.participants)
    if (!parts.includes(me.uid) || !parts.includes(targetUid) || targetUid === me.uid) return false
    if (!data.players[targetUid]) return false
    backend.set(`${base}/votes/${me.uid}`, targetUid)
    return true
  }

  function submitGuess(text) {
    const st = data.state
    if (!joined || st?.phase !== 'guess' || data.secret?.impostor !== me.uid) return false
    const t = clean(text, 30)
    if (!t) return false
    backend.set(`${base}/guess`, t)
    return true
  }

  // ---------- Azioni dell'host ----------

  async function startGame() {
    const st = data.state
    if (!joined || starting || !isHost() || (st && st.phase !== 'lobby')) return false
    const present = playerList().map((p) => p.uid)
    if (present.length < MIN_PLAYERS) return false
    starting = true
    try {
      const { category, word } = pickWord()
      const impostor = pick(present)
      await Promise.all([
        backend.remove(`${base}/clues`),
        backend.remove(`${base}/votes`),
        backend.remove(`${base}/guess`),
      ])
      await backend.set(`${base}/secret`, { impostor, word, category })
      await backend.set(`${base}/state`, {
        phase: 'clues',
        seq: (st?.seq || 0) + 1,
        round: (st?.round || 0) + 1,
        participants: present,
        turnOrder: shuffle(present),
        turnIndex: 0,
        deadline: backend.now() + T.clue,
      })
      return true
    } finally {
      starting = false
    }
  }

  async function endToLobby(notice) {
    await Promise.all([
      backend.remove(`${base}/secret`),
      backend.remove(`${base}/clues`),
      backend.remove(`${base}/votes`),
      backend.remove(`${base}/guess`),
    ])
    await backend.set(`${base}/state`, {
      phase: 'lobby',
      seq: (data.state?.seq || 0) + 1,
      round: data.state?.round || 0,
      notice: notice || null,
    })
  }

  function backToLobby() {
    if (!isHost() || data.state?.phase !== 'result') return false
    endToLobby(null)
    return true
  }

  function finish(fields) {
    const s = data.secret
    patchState({
      phase: 'result',
      winner: fields.winner,
      reason: fields.reason,
      word: s.word,
      impostor: s.impostor,
      category: s.category,
      accused: fields.accused ?? null,
      tally: fields.tally ?? null,
      guess: fields.guess ?? null,
      deadline: null,
    })
  }

  // ---------- Avanzamento automatico (solo host) ----------

  function tick() {
    if (!joined || !isHost()) return
    const st = data.state
    if (!st || st.phase === 'lobby' || st.phase === 'result') return
    const secret = data.secret
    if (!secret) return
    const now = backend.now()
    const present = data.players
    const alive = toArray(st.participants).filter((u) => present[u])

    // Troppe uscite? (con un po' di tolleranza per chi ricarica la pagina)
    const tooFew = alive.length < MIN_IN_GAME
    const impostorGone = !present[secret.impostor]
    if (tooFew || impostorGone) {
      if (grace.since == null) grace.since = now
      if (now - grace.since > T.grace) {
        grace.since = null
        if (tooFew) endToLobby('Partita annullata: sono usciti troppi giocatori.')
        else finish({ winner: 'crew', reason: 'impostor-left' })
        return
      }
    } else {
      grace.since = null
    }

    switch (st.phase) {
      case 'clues': {
        const order = toArray(st.turnOrder)
        const cur = order[st.turnIndex]
        const done = cur != null && data.clues[cur] != null
        if (cur == null || done || !present[cur] || now > st.deadline) {
          if (cur != null && !done) backend.set(`${base}/clues/${cur}`, '—')
          const next = st.turnIndex + 1
          if (next >= order.length) {
            patchState({ phase: 'discussion', deadline: now + T.discuss })
          } else {
            patchState({ turnIndex: next, deadline: now + T.clue })
          }
        }
        break
      }
      case 'discussion':
        if (now > st.deadline) patchState({ phase: 'voting', deadline: now + T.vote })
        break
      case 'voting': {
        const valid = (u) => data.votes[u] && alive.includes(data.votes[u]) && data.votes[u] !== u
        const everyone = alive.every(valid)
        if (everyone || now > st.deadline) {
          const counts = {}
          for (const u of alive) if (valid(u)) counts[data.votes[u]] = (counts[data.votes[u]] || 0) + 1
          const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
          const top = sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1]) ? sorted[0][0] : null
          const tally = sorted.length ? counts : null
          if (top && top === secret.impostor) {
            patchState({ phase: 'guess', accused: top, tally, deadline: now + T.guess })
          } else {
            finish({ winner: 'impostor', reason: top ? 'wrong-accused' : 'tie', accused: top, tally })
          }
        }
        break
      }
      case 'guess':
        if (data.guess != null || now > st.deadline) {
          const ok = data.guess != null && normalize(data.guess) === normalize(secret.word)
          finish({
            winner: ok ? 'impostor' : 'crew',
            reason: ok ? 'guessed' : 'caught',
            accused: st.accused,
            tally: st.tally,
            guess: data.guess,
          })
        }
        break
    }
  }

  return {
    me,
    backend,
    data,
    timers: T,
    join,
    leave,
    tick,
    setPos,
    submitClue,
    vote,
    submitGuess,
    startGame,
    backToLobby,
    playerList,
    hostUid,
    isHost,
  }
}
