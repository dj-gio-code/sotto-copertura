// Interfaccia grafica della partita: stanza pentagonale, lobby, ingranaggio con link d'invito,
// ruoli, indizi, voto e indovinello finale. La logica sta in session.js, la rete in backend.js.

import { getBackend } from './backend.js'
import { createSession, MIN_PLAYERS, MAX_PLAYERS, toArray, normalize } from './session.js'

const PHOTO_KEY = 'sotto-copertura:foto-profilo'
const NAME_KEY = 'sotto-copertura:nome'
const UID_KEY = 'sotto-copertura:uid'
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// Pentagono regolare con raggio 1 (vertice verso l'alto).
const STEP = (2 * Math.PI) / 5
const APOTHEM = Math.cos(Math.PI / 5)
const VERTS = Array.from({ length: 5 }, (_, k) => {
  const a = -Math.PI / 2 + k * STEP
  return { x: Math.cos(a), y: Math.sin(a) }
})
const WALLS = Array.from({ length: 5 }, (_, k) => {
  const a = -Math.PI / 2 + (k + 0.5) * STEP
  return { nx: Math.cos(a), ny: Math.sin(a) }
})

const SPEED = 0.9 // unità di raggio al secondo
const RADIUS = 0.09 // ingombro del personaggio contro i muri
const POS_EVERY_MS = 100

const GEAR_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="3"></circle>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
</svg>`

// ---------- Utilità ----------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

function safeGet(key, storage = 'localStorage') {
  try {
    return window[storage].getItem(key)
  } catch {
    return null
  }
}

function safeSet(key, value, storage = 'localStorage') {
  try {
    window[storage].setItem(key, value)
  } catch {
    /* storage non disponibile: i dati valgono solo per questa sessione */
  }
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

// Un id per scheda: così chi ricarica la pagina rientra come lo stesso giocatore.
function getUid() {
  let uid = safeGet(UID_KEY, 'sessionStorage')
  if (!uid) {
    uid = randomId()
    safeSet(UID_KEY, uid, 'sessionStorage')
  }
  return uid
}

const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)

function randomCode() {
  let s = ''
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return s
}

// Ritaglia la foto in un quadrato piccolo per tenerla leggera nel database.
function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const size = 112
      const c = document.createElement('canvas')
      c.width = c.height = size
      const s = Math.min(img.width, img.height)
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/jpeg', 0.8))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('immagine non valida'))
    }
    img.src = url
  })
}

// ---------- Gioco ----------

export function startGame(root, onExit, opts = {}) {
  const joinCode = cleanCode(opts.joinCode)

  root.innerHTML = `
    <div class="room">
      <canvas id="room-canvas"></canvas>
      <button class="icon-btn back" data-act="leave" title="Esci dalla stanza" aria-label="Esci dalla stanza">←</button>
      <button class="icon-btn gear" data-act="gear" title="Impostazioni e invito" aria-label="Impostazioni">${GEAR_SVG}</button>
      <div class="banner" id="banner" hidden></div>
      <div class="role-pill" id="role" hidden></div>
      <aside class="clue-log" id="clue-log" hidden></aside>
      <section class="settings" id="settings" hidden></section>
      <div class="role-card" id="rolecard" hidden></div>
      <div class="action" id="action" hidden></div>
      <div class="modal-wrap" id="modal" hidden></div>
      <div class="toasts" id="toasts"></div>
    </div>
  `

  const $ = (sel) => root.querySelector(sel)
  const canvas = $('#room-canvas')
  const ctx = canvas.getContext('2d')
  const elBanner = $('#banner')
  const elRole = $('#role')
  const elRoleCard = $('#rolecard')
  const elLog = $('#clue-log')
  const elSettings = $('#settings')
  const elAction = $('#action')
  const elModal = $('#modal')
  const elToasts = $('#toasts')

  // ---------- Stato ----------
  const profile = { name: safeGet(NAME_KEY) || '', photo: safeGet(PHOTO_KEY) }
  const me = { uid: getUid(), name: '', photo: null }
  let session = null
  let roomCode = null
  let connected = false
  let fatal = false
  let destroyed = false
  let settingsOpen = false
  let roleShownRound = -1
  let roleTimer = null
  let lastNoticeSeq = -1

  const sprites = new Map() // uid -> {x, y, phase, mv, init, img, imgSrc}
  const names = new Map()
  const drafts = {}
  const sigs = {}
  const keys = {}

  let px = 0
  let py = 0
  let meInit = false
  let moving = false
  const lastSent = { x: 0, y: 0, mv: false, t: 0 }

  const data = () => session.data
  const nameOf = (uid) => names.get(uid) || '???'

  // ---------- Dimensioni ----------
  let w = 0
  let h = 0
  let R = 0
  let cx = 0
  let cy = 0

  function resize() {
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    w = rect.width
    h = rect.height
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // il pentagono va da y=-1 a y=+0.809 (altezza 1.809 R): lo centro nello spazio libero
    const topReserve = 125
    const bottomReserve = 150
    const availH = Math.max(200, h - topReserve - bottomReserve)
    R = Math.max(120, Math.min(w * 0.44, availH / 1.809))
    cx = w / 2
    cy = topReserve + (availH - 1.809 * R) / 2 + R
  }

  const ro = new ResizeObserver(resize)
  ro.observe(canvas)
  resize()

  // ---------- Input ----------
  const isTyping = (t) => t && t.closest && t.closest('input, textarea')
  const controlsOn = () => connected && !fatal && elModal.hidden

  const onKeyDown = (e) => {
    if (e.code === 'Escape') {
      if (settingsOpen) toggleSettings(false)
      return
    }
    if (isTyping(e.target)) return
    keys[e.code] = true
  }
  const onKeyUp = (e) => {
    keys[e.code] = false
  }
  const clearKeys = () => {
    for (const k in keys) keys[k] = false
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', clearKeys)
  root.addEventListener('focusin', (e) => {
    if (isTyping(e.target)) clearKeys()
  })

  // ---------- Toast ----------
  function toast(text) {
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = text
    elToasts.appendChild(el)
    setTimeout(() => el.classList.add('out'), 3600)
    setTimeout(() => el.remove(), 4200)
  }

  // ---------- Rendering HTML con firma (si ricostruisce solo se cambia) ----------
  function setHtml(el, key, html) {
    if (sigs[key] === html) return false
    const a = document.activeElement
    const keep = a && el.contains(a) && a.id ? { id: a.id, pos: a.selectionStart } : null
    sigs[key] = html
    el.innerHTML = html
    el.querySelectorAll('input[id]').forEach((inp) => {
      if (drafts[inp.id] != null) inp.value = drafts[inp.id]
    })
    if (keep) {
      const n = el.querySelector('#' + keep.id)
      if (n) {
        n.focus()
        try {
          n.setSelectionRange(keep.pos, keep.pos)
        } catch {
          /* input senza selezione */
        }
      }
    }
    return true
  }

  function showCard(html) {
    sigs.modal = null
    elModal.hidden = false
    elModal.innerHTML = html
    clearKeys()
  }

  // ---------- Schede iniziali: profilo, stato, errori ----------
  function showProfileCard(err = '') {
    const typed = $('#name-input')
    if (typed) profile.name = typed.value
    const photo = profile.photo
      ? `<img src="${esc(profile.photo)}" alt="La tua foto" />`
      : '<span aria-hidden="true">👤</span>'
    showCard(`
      <div class="card">
        <h2>${joinCode ? 'Sei stato invitato!' : 'Crea la tua stanza'}</h2>
        <p class="hint">Scegli nome e foto: così ti vedranno gli altri giocatori.</p>
        <div class="avatar-preview">${photo}</div>
        <label class="file-btn">${profile.photo ? 'Cambia foto' : 'Scegli una foto'}
          <input id="photo-input" type="file" accept="image/*" hidden />
        </label>
        <input id="name-input" type="text" maxlength="14" placeholder="Il tuo nome" value="${esc(profile.name)}" autocomplete="off" />
        <button data-act="enter">${joinCode ? 'Entra nella stanza' : 'Crea stanza'}</button>
        ${err ? `<p class="err">${esc(err)}</p>` : ''}
      </div>`)
    const inp = $('#name-input')
    if (inp) inp.focus()
  }

  function showStatus(text) {
    showCard(`<div class="card"><p class="status">${esc(text)}</p></div>`)
  }

  function showFatal(text) {
    fatal = true
    showCard(`
      <div class="card">
        <h2>Ops</h2>
        <p>${esc(text)}</p>
        <button data-act="menu">Torna al menu</button>
      </div>`)
  }

  async function enter() {
    const typed = ($('#name-input')?.value || '').replace(/\s+/g, ' ').trim()
    profile.name = typed.slice(0, 14) || 'Giocatore'
    safeSet(NAME_KEY, profile.name)
    me.name = profile.name
    me.photo = profile.photo || null
    showStatus(joinCode ? 'Entro nella stanza…' : 'Creo la stanza…')

    try {
      const backend = await getBackend()
      if (joinCode) {
        roomCode = joinCode
        const state = await backend.get(`rooms/${roomCode}/state`)
        if (!state) return showProfileCard('Stanza non trovata: il link è sbagliato o la stanza non esiste più.')
      } else {
        for (let i = 0; i < 6; i++) {
          const c = randomCode()
          if (!(await backend.get(`rooms/${c}/state`))) {
            roomCode = c
            break
          }
        }
        if (!roomCode) throw new Error('codice')
      }

      session = createSession({ backend, code: roomCode, me, onChange: onData })
      const res = await session.join()
      if (!res.ok) {
        session = null
        return showFatal(
          res.reason === 'full'
            ? `La stanza è piena (${MAX_PLAYERS}/${MAX_PLAYERS} giocatori).`
            : 'La partita è già iniziata: non si può entrare adesso.'
        )
      }
    } catch (err) {
      console.error(err)
      session = null
      return showProfileCard('Non riesco a collegarmi al database. Controlla la configurazione e riprova.')
    }

    if (!joinCode) {
      try {
        history.replaceState(null, '', `?stanza=${roomCode}`)
      } catch {
        /* ambienti senza history */
      }
    }
    connected = true
    elModal.hidden = true
    sigs.modal = null
    onData(session.data)
  }

  // ---------- Dati dal database ----------
  function ensureSprite(uid, p) {
    let s = sprites.get(uid)
    if (!s) {
      s = { x: 0, y: 0, phase: 0, mv: false, init: false, img: null, imgSrc: null }
      sprites.set(uid, s)
    }
    const src = p.photo || null
    if (src !== s.imgSrc) {
      s.imgSrc = src
      s.img = null
      if (src) {
        const im = new Image()
        im.onload = () => {
          if (s.imgSrc === src) s.img = im
        }
        im.src = src
      }
    }
  }

  function onData(d) {
    if (!connected || destroyed) return
    for (const [uid, p] of Object.entries(d.players)) {
      names.set(uid, p.name)
      ensureSprite(uid, p)
    }
    for (const uid of [...sprites.keys()]) if (!d.players[uid]) sprites.delete(uid)

    const st = d.state
    if (st && st.phase === 'lobby' && st.notice && st.seq !== lastNoticeSeq) {
      lastNoticeSeq = st.seq
      toast(st.notice)
    }

    // Scheda "il tuo ruolo" a inizio partita
    if (st && st.phase === 'clues' && d.secret && st.round !== roleShownRound && toArray(st.participants).includes(me.uid)) {
      roleShownRound = st.round
      elRoleCard.hidden = false
      clearTimeout(roleTimer)
      roleTimer = setTimeout(closeRoleCard, 12000)
    }
    if (!st || st.phase === 'lobby') closeRoleCard()

    renderHud()
  }

  function closeRoleCard() {
    clearTimeout(roleTimer)
    elRoleCard.hidden = true
  }

  // ---------- HUD ----------
  const timeLeft = () => {
    const dl = session?.data.state?.deadline
    return dl ? Math.max(0, Math.ceil((dl - session.backend.now()) / 1000)) : 0
  }

  function myRole() {
    const d = data()
    const st = d.state
    if (!st || st.phase === 'lobby' || !d.secret) return null
    if (!toArray(st.participants).includes(me.uid)) return null
    return { imp: d.secret.impostor === me.uid, word: d.secret.word, category: d.secret.category }
  }

  function bannerInfo() {
    const d = data()
    const st = d.state
    const n = Object.keys(d.players).length
    if (!st || st.phase === 'lobby') {
      if (n < MIN_PLAYERS)
        return `In attesa di giocatori: ${n}/${MIN_PLAYERS} minimo (massimo ${MAX_PLAYERS}). Invita gli amici dall'ingranaggio ⚙️`
      if (session.isHost()) return `Siete in ${n}! Quando siete pronti, avvia la partita`
      return `Siete in ${n}: aspetta che ${nameOf(session.hostUid())} avvii la partita`
    }
    const order = toArray(st.turnOrder)
    switch (st.phase) {
      case 'clues': {
        const cur = order[st.turnIndex]
        return cur === me.uid
          ? 'Tocca a te! Scrivi un indizio'
          : `Tocca a ${nameOf(cur)} · indizio ${st.turnIndex + 1}/${order.length}`
      }
      case 'discussion':
        return "Discutete! Chi è l'impostore?"
      case 'voting':
        return "Votate: chi è l'impostore?"
      case 'guess':
        return `${nameOf(st.accused)} era l'impostore! Ora prova a indovinare la parola`
      case 'result':
        return st.winner === 'crew' ? 'Vincono i giocatori!' : "Vince l'impostore!"
      default:
        return ''
    }
  }

  function roleHtml() {
    const r = myRole()
    if (!r) return ''
    return r.imp
      ? `<b>Sei l'IMPOSTORE</b> · Categoria: ${esc(r.category)}`
      : `Parola segreta: <b>${esc(cap(r.word))}</b> · ${esc(r.category)}`
  }

  function roleCardHtml() {
    const r = myRole()
    if (!r) return ''
    return r.imp
      ? `<p class="eyebrow">Il tuo ruolo</p>
         <h2 class="big bad">SEI L'IMPOSTORE</h2>
         <p>Non conosci la parola segreta.<br />Categoria: <b>${esc(r.category)}</b></p>
         <p class="hint">Dai indizi credibili senza farti scoprire!</p>
         <button data-act="roleok">Ho capito</button>`
      : `<p class="eyebrow">Sei un giocatore innocente</p>
         <h2 class="big">${esc(cap(r.word))}</h2>
         <p>Categoria: <b>${esc(r.category)}</b></p>
         <p class="hint">Dai un indizio che mostri che la conosci, senza renderla troppo ovvia.</p>
         <button data-act="roleok">Ho capito</button>`
  }

  function actionHtml() {
    const d = data()
    const st = d.state
    const n = Object.keys(d.players).length
    if (!st || st.phase === 'lobby') {
      if (!session.isHost()) return ''
      return n >= MIN_PLAYERS
        ? `<button data-act="start">Avvia partita (${n} giocatori)</button>`
        : `<p class="hint">Servono ancora ${MIN_PLAYERS - n} giocatori per iniziare</p>`
    }
    if (st.phase === 'clues') {
      const cur = toArray(st.turnOrder)[st.turnIndex]
      if (cur === me.uid && d.clues[me.uid] == null)
        return `<div class="row">
          <input id="clue-input" type="text" maxlength="24" placeholder="Il tuo indizio (una parola)" autocomplete="off" />
          <button data-act="clue">Invia</button>
        </div>`
      return ''
    }
    if (st.phase === 'voting') {
      const alive = toArray(st.participants).filter((u) => d.players[u])
      const voted = alive.filter((u) => d.votes[u]).length
      const mine = d.votes[me.uid] || null
      const btns = alive
        .filter((u) => u !== me.uid)
        .map((u) => {
          const p = d.players[u]
          const img = p.photo ? `<img src="${esc(p.photo)}" alt="" />` : ''
          return `<button class="vote ${mine === u ? 'sel' : ''}" data-act="vote" data-uid="${esc(u)}">${img}${esc(p.name)}</button>`
        })
        .join('')
      return `<p class="hint">${mine ? 'Hai votato (puoi cambiare voto).' : 'Tocca il nome di chi sospetti.'} Hanno votato ${voted}/${alive.length}</p>
        <div class="vote-grid">${btns}</div>`
    }
    return ''
  }

  function logHtml() {
    const d = data()
    const st = d.state
    if (!st || st.phase === 'lobby') return ''
    const order = toArray(st.turnOrder)
    const rows = order
      .filter((u) => d.clues[u] != null)
      .map((u) => `<div class="lg-row"><span>${esc(nameOf(u))}</span><b>${esc(d.clues[u])}</b></div>`)
      .join('')
    return rows ? `<h3>Indizi</h3>${rows}` : ''
  }

  function reasonText(st) {
    const acc = st.accused ? nameOf(st.accused) : ''
    switch (st.reason) {
      case 'impostor-left':
        return "L'impostore ha abbandonato la partita."
      case 'wrong-accused':
        return `Avete accusato ${acc}, ma era innocente.`
      case 'tie':
        return "Voti in parità (o nessun voto): l'impostore la fa franca."
      case 'guessed':
        return `L'impostore ha indovinato la parola: «${st.guess}»!`
      case 'caught':
        return st.guess ? `L'impostore ha scritto «${st.guess}»: sbagliato!` : "L'impostore non ha indovinato in tempo."
      default:
        return ''
    }
  }

  function modalHtml() {
    const d = data()
    const st = d.state
    if (!st) return ''
    if (st.phase === 'guess') {
      const r = myRole()
      if (r && r.imp)
        return `<div class="card">
          <h2>Ti hanno scoperto!</h2>
          <p>Scrivi la parola segreta: se la indovini vinci tu.<br />Categoria: <b>${esc(r.category)}</b></p>
          <div class="row">
            <input id="guess-input" type="text" maxlength="30" placeholder="La parola segreta" autocomplete="off" />
            <button data-act="guess">Invia</button>
          </div>
          <p class="hint">Tempo: <span data-timer></span>s</p>
        </div>`
      return `<div class="card">
        <h2>${esc(nameOf(st.accused))} era l'impostore!</h2>
        <p>Sta cercando di indovinare la parola segreta…</p>
        <p class="hint"><span data-timer></span>s</p>
      </div>`
    }
    if (st.phase === 'result') {
      const crew = st.winner === 'crew'
      const lines = Object.entries(d.votes || {})
        .filter(([a, b]) => b && (d.players[a] || names.has(a)))
        .map(([a, b]) => `<li>${esc(nameOf(a))} → ${esc(nameOf(b))}</li>`)
        .join('')
      return `<div class="card ${crew ? 'win' : 'lose'}">
        <p class="eyebrow">Fine partita</p>
        <h2 class="big ${crew ? '' : 'bad'}">${crew ? 'Vincono i giocatori!' : "Vince l'impostore!"}</h2>
        <p>${esc(reasonText(st))}</p>
        <p>L'impostore era <b>${esc(nameOf(st.impostor))}</b><br />La parola era <b>${esc(cap(st.word))}</b> <span class="hint">(${esc(st.category)})</span></p>
        ${lines ? `<details><summary>Chi ha votato chi</summary><ol class="votes">${lines}</ol></details>` : ''}
        ${
          session.isHost()
            ? '<button data-act="again">Nuova partita</button>'
            : `<p class="hint">Aspetta che ${esc(nameOf(session.hostUid()))} avvii una nuova partita…</p>`
        }
      </div>`
    }
    return ''
  }

  function settingsHtml() {
    const d = data()
    const st = d.state
    const n = Object.keys(d.players).length
    const inLobby = !st || st.phase === 'lobby'
    const host = session.hostUid()
    const list = session
      .playerList()
      .map(
        (p) =>
          `<li>${esc(p.name)}${p.uid === me.uid ? ' <span class="tag">tu</span>' : ''}${p.uid === host ? ' <span class="tag">host</span>' : ''}</li>`
      )
      .join('')
    let status
    if (!inLobby) status = 'Partita in corso: la stanza è chiusa a nuovi ingressi.'
    else if (n >= MAX_PLAYERS) status = `Stanza piena (${MAX_PLAYERS}/${MAX_PLAYERS}).`
    else if (n < MIN_PLAYERS) status = `Mancano ${MIN_PLAYERS - n} giocatori per poter iniziare.`
    else status = `Ci siete! Si può iniziare. Possono ancora entrare altri giocatori fino a ${MAX_PLAYERS}.`
    const url = `${location.origin}${location.pathname}?stanza=${roomCode}`
    const localNote =
      session.backend.kind === 'local'
        ? `<p class="note">Modalità di prova: il link funziona solo tra schede dello stesso browser. Per giocare online collega Firebase in <code>src/firebase-config.js</code>.</p>`
        : ''
    return `
      <div class="settings-head"><h2>Impostazioni</h2><button class="x" data-act="gear" aria-label="Chiudi">✕</button></div>
      <h3>Invita giocatori</h3>
      <div class="link-row">
        <input id="invite-link" type="text" readonly value="${esc(url)}" />
        <button data-act="copy">Copia</button>
      </div>
      <p class="hint">${esc(status)}</p>
      ${localNote}
      <h3>Giocatori ${n}/${MAX_PLAYERS} <span class="hint">(minimo ${MIN_PLAYERS})</span></h3>
      <ol class="plist">${list}</ol>
      ${
        inLobby && session.isHost()
          ? `<button data-act="start" ${n >= MIN_PLAYERS ? '' : 'disabled'}>Avvia partita</button>`
          : ''
      }`
  }

  function renderHud() {
    if (!connected || fatal || !session) return
    const text = bannerInfo()
    const hasTimer = !!data().state?.deadline
    setHtml(elBanner, 'banner', `${esc(text)}${hasTimer ? ' <span class="timer"><span data-timer></span>s</span>' : ''}`)
    elBanner.hidden = !text

    const role = roleHtml()
    setHtml(elRole, 'role', role)
    elRole.hidden = !role
    elRole.classList.toggle('impostor', !!myRole()?.imp)

    setHtml(elRoleCard, 'rolecard', roleCardHtml())

    const log = logHtml()
    setHtml(elLog, 'log', log)
    elLog.hidden = !log

    const act = actionHtml()
    setHtml(elAction, 'action', act)
    elAction.hidden = !act

    const modal = modalHtml()
    if (modal) {
      if (elModal.hidden) clearKeys()
      setHtml(elModal, 'modal', modal)
      elModal.hidden = false
    } else if (sigs.modal != null) {
      sigs.modal = null
      elModal.hidden = true
      elModal.innerHTML = ''
    }

    if (settingsOpen) setHtml(elSettings, 'settings', settingsHtml())
    updateTimers()
  }

  function updateTimers() {
    if (!session) return
    const t = String(timeLeft())
    root.querySelectorAll('[data-timer]').forEach((el) => {
      if (el.textContent !== t) el.textContent = t
    })
  }
  const timerInterval = setInterval(updateTimers, 250)

  function toggleSettings(open) {
    settingsOpen = open ?? !settingsOpen
    elSettings.hidden = !settingsOpen
    if (settingsOpen && session) {
      sigs.settings = null
      setHtml(elSettings, 'settings', settingsHtml())
    }
  }

  // ---------- Azioni ----------
  async function copyLink() {
    const input = $('#invite-link')
    if (!input) return
    try {
      await navigator.clipboard.writeText(input.value)
      toast('Link copiato!')
    } catch {
      input.select()
      toast('Seleziona il link e copialo (Ctrl+C)')
    }
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]')
    if (!b || b.disabled) return
    const d = session ? data() : null
    switch (b.dataset.act) {
      case 'enter':
        enter()
        break
      case 'menu':
        exit()
        break
      case 'leave':
        leave()
        break
      case 'gear':
        if (connected) toggleSettings()
        break
      case 'copy':
        copyLink()
        break
      case 'roleok':
        closeRoleCard()
        break
      case 'start':
        b.disabled = true
        session.startGame().then((ok) => {
          if (!ok) toast('Non si può avviare adesso.')
        })
        break
      case 'again':
        session.backToLobby()
        break
      case 'vote':
        session.vote(b.dataset.uid)
        break
      case 'clue': {
        const text = (drafts['clue-input'] || '').trim()
        if (!text) return
        if (/\s/.test(text)) return toast('Scrivi una sola parola!')
        const r = myRole()
        if (r && !r.imp && normalize(text) === normalize(d.secret.word))
          return toast('Non puoi usare la parola segreta!')
        if (session.submitClue(text)) drafts['clue-input'] = ''
        else toast('Non è il tuo turno.')
        break
      }
      case 'guess': {
        const text = (drafts['guess-input'] || '').trim()
        if (text && session.submitGuess(text)) drafts['guess-input'] = ''
        break
      }
    }
  }

  root.addEventListener('click', onClick)
  root.addEventListener('input', (e) => {
    if (e.target.id) drafts[e.target.id] = e.target.value
  })
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const id = e.target.id
    if (id === 'name-input') enter()
    else if (id === 'clue-input') onClick({ target: root.querySelector('[data-act="clue"]') || e.target })
    else if (id === 'guess-input') onClick({ target: root.querySelector('[data-act="guess"]') || e.target })
  })
  root.addEventListener('change', async (e) => {
    if (e.target.id !== 'photo-input') return
    const file = e.target.files && e.target.files[0]
    if (!file) return
    try {
      const url = await fileToAvatar(file)
      profile.photo = url
      safeSet(PHOTO_KEY, url)
      showProfileCard()
    } catch {
      showProfileCard('Questa immagine non si apre: prova con un\'altra foto.')
    }
  })

  // ---------- Movimento ----------
  function update(dt, now) {
    if (!session) return
    const d = data()
    if (!meInit) {
      const p = d.pos[me.uid]
      if (p) {
        px = p.x
        py = p.y
        meInit = true
      }
    }

    let dx = 0
    let dy = 0
    if (meInit && controlsOn()) {
      if (keys.KeyW) dy -= 1
      if (keys.KeyS) dy += 1
      if (keys.KeyA) dx -= 1
      if (keys.KeyD) dx += 1
    }
    moving = dx !== 0 || dy !== 0
    if (moving) {
      const len = Math.hypot(dx, dy)
      px += (dx / len) * SPEED * dt
      py += (dy / len) * SPEED * dt
    }
    // Muri: spingo fuori il personaggio, così scivola lungo le pareti.
    for (let pass = 0; pass < 2; pass++) {
      for (const { nx, ny } of WALLS) {
        const over = px * nx + py * ny - (APOTHEM - RADIUS)
        if (over > 0) {
          px -= over * nx
          py -= over * ny
        }
      }
    }

    const k = Math.min(1, dt * 14)
    for (const [uid, s] of sprites) {
      if (uid === me.uid) {
        if (meInit) {
          s.x = px
          s.y = py
          s.init = true
        }
        s.mv = moving
      } else {
        const p = d.pos[uid]
        if (p) {
          if (!s.init) {
            s.x = p.x
            s.y = p.y
            s.init = true
          }
          s.x += (p.x - s.x) * k
          s.y += (p.y - s.y) * k
          s.mv = !!p.m
        } else {
          s.mv = false
        }
      }
      if (s.mv) s.phase += dt * 11
    }

    // Posizione agli altri (a scatti per non intasare il database)
    if (meInit && connected) {
      const changed =
        moving !== lastSent.mv || Math.abs(px - lastSent.x) > 0.002 || Math.abs(py - lastSent.y) > 0.002
      if (changed && now - lastSent.t >= POS_EVERY_MS) {
        session.setPos(px, py, moving)
        lastSent.x = px
        lastSent.y = py
        lastSent.mv = moving
        lastSent.t = now
      }
    }
  }

  // ---------- Disegno ----------
  function polyPath(scale) {
    ctx.beginPath()
    VERTS.forEach((v, i) => {
      const x = cx + v.x * R * scale
      const y = cy + v.y * R * scale
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.closePath()
  }

  function drawRoom() {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
    g.addColorStop(0, '#2f3463')
    g.addColorStop(1, '#1b1d3b')
    polyPath(1)
    ctx.fillStyle = g
    ctx.fill()

    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 2
    polyPath(0.55)
    ctx.stroke()
    ctx.beginPath()
    for (const v of VERTS) {
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + v.x * R * 0.55, cy + v.y * R * 0.55)
    }
    ctx.stroke()

    ctx.save()
    ctx.shadowColor = 'rgba(255, 77, 109, 0.35)'
    ctx.shadowBlur = R * 0.08
    ctx.strokeStyle = '#555ba3'
    ctx.lineWidth = R * 0.05
    ctx.lineJoin = 'round'
    polyPath(1)
    ctx.stroke()
    ctx.restore()
  }

  function bubble(text, x, y, u) {
    ctx.font = `600 ${Math.max(11, u * 0.05)}px system-ui, sans-serif`
    const bw = ctx.measureText(text).width + u * 0.06
    const bh = u * 0.08
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x - bw / 2, y - bh, bw, bh, bh / 2)
    else ctx.rect(x - bw / 2, y - bh, bw, bh)
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(x - u * 0.015, y)
    ctx.lineTo(x + u * 0.015, y)
    ctx.lineTo(x, y + u * 0.02)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#14152b'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x, y - bh / 2 + 1)
  }

  function ringFor(uid, st) {
    if (!st) return null
    if (st.phase === 'clues' && toArray(st.turnOrder)[st.turnIndex] === uid) return '#ffd54f'
    if ((st.phase === 'guess' || st.phase === 'result') && st.accused === uid) return '#ff4d6d'
    if (st.phase === 'result' && st.impostor === uid) return '#ff4d6d'
    return null
  }

  function drawPlayer(uid, s) {
    const d = data()
    const p = d.players[uid]
    if (!p) return
    const st = d.state
    const u = R
    const x = cx + s.x * R
    const y = cy + s.y * R

    // anello di evidenza (turno / accusato / impostore svelato)
    const ring = ringFor(uid, st)
    if (ring) {
      ctx.strokeStyle = ring
      ctx.lineWidth = 0.014 * u
      ctx.beginPath()
      ctx.ellipse(x, y + 0.1 * u, 0.1 * u, 0.04 * u, 0, 0, Math.PI * 2)
      ctx.stroke()
    }

    // ombra
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.beginPath()
    ctx.ellipse(x, y + 0.1 * u, 0.07 * u, 0.025 * u, 0, 0, Math.PI * 2)
    ctx.fill()

    // gambe (si alternano mentre cammina)
    ctx.strokeStyle = p.color || '#9aa0a6'
    ctx.lineWidth = 0.032 * u
    ctx.lineCap = 'round'
    for (const side of [-1, 1]) {
      const lift = s.mv ? Math.max(0, Math.sin(s.phase + (side > 0 ? Math.PI : 0))) * 0.03 * u : 0
      const lx = x + side * 0.028 * u
      ctx.beginPath()
      ctx.moveTo(lx, y)
      ctx.lineTo(lx, y + 0.09 * u - lift)
      ctx.stroke()
    }

    // testa con la foto
    const hr = 0.075 * u
    const hx = x
    const hy = y - 0.055 * u
    ctx.save()
    ctx.beginPath()
    ctx.arc(hx, hy, hr, 0, Math.PI * 2)
    ctx.clip()
    if (s.img) {
      ctx.drawImage(s.img, hx - hr, hy - hr, hr * 2, hr * 2)
    } else {
      ctx.fillStyle = '#6b72c4'
      ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2)
      ctx.fillStyle = '#e8e9ff'
      ctx.beginPath()
      ctx.arc(hx, hy - hr * 0.2, hr * 0.32, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(hx, hy + hr * 0.85, hr * 0.7, hr * 0.5, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    ctx.strokeStyle = uid === me.uid ? '#ffd54f' : '#ffffff'
    ctx.lineWidth = 0.012 * u
    ctx.beginPath()
    ctx.arc(hx, hy, hr, 0, Math.PI * 2)
    ctx.stroke()

    // nome sotto i piedi (con ✓ se ha già votato)
    const voted = st && st.phase === 'voting' && d.votes[uid]
    ctx.font = `600 ${Math.max(11, u * 0.045)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(10,10,22,0.9)'
    ctx.fillStyle = '#ffffff'
    const label = `${p.name}${voted ? ' ✓' : ''}`
    ctx.strokeText(label, x, y + 0.17 * u)
    ctx.fillText(label, x, y + 0.17 * u)
    if (st && st.phase === 'result' && st.impostor === uid) {
      ctx.fillStyle = '#ff4d6d'
      ctx.font = `700 ${Math.max(10, u * 0.04)}px system-ui, sans-serif`
      ctx.strokeText('IMPOSTORE', x, y + 0.225 * u)
      ctx.fillText('IMPOSTORE', x, y + 0.225 * u)
    }

  }

  // Il fumetto con l'indizio si disegna dopo tutti i personaggi, così non finisce coperto.
  function drawClue(uid, s) {
    const d = data()
    const st = d.state
    const clue = st && st.phase !== 'lobby' ? d.clues[uid] : null
    if (clue == null || !d.players[uid]) return
    const u = R
    bubble(clue, cx + s.x * R, cy + s.y * R - 0.055 * u - 0.075 * u - 0.03 * u, u)
  }

  function draw() {
    ctx.clearRect(0, 0, w, h)
    drawRoom()
    if (!session) return
    const list = [...sprites.entries()].filter(([, s]) => s.init).sort((a, b) => a[1].y - b[1].y)
    for (const [uid, s] of list) drawPlayer(uid, s)
    for (const [uid, s] of list) drawClue(uid, s)
  }

  // ---------- Loop ----------
  let last = performance.now()
  let raf = 0
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    update(dt, now)
    draw()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  // ---------- Uscita ----------
  function destroy() {
    if (destroyed) return
    destroyed = true
    cancelAnimationFrame(raf)
    clearInterval(timerInterval)
    clearTimeout(roleTimer)
    ro.disconnect()
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', clearKeys)
    window.removeEventListener('pagehide', leaveQuiet)
    if (session) session.leave()
  }

  function exit() {
    destroy()
    onExit()
  }

  function leaveQuiet() {
    if (session) session.leave()
  }
  window.addEventListener('pagehide', leaveQuiet)

  function leave() {
    const st = session?.data.state
    const playing = st && st.phase !== 'lobby' && st.phase !== 'result'
    if (playing && !confirm('La partita è in corso. Vuoi davvero uscire?')) return
    exit()
  }

  showProfileCard()
}
