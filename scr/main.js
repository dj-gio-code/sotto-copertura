import './style.css'
import { startGame } from './game.js'

// ✏️ Cambia qui il nome del gioco
const GAME_NAME = 'Sotto Copertura'

const app = document.getElementById('app')

// ---------- Schermate ----------

function showMenu() {
  app.innerHTML = `
    <main class="screen menu">
      <h1 class="title">${GAME_NAME}</h1>
      <div class="buttons">
        <button id="btn-play">Gioca</button>
        <button id="btn-settings">Impostazioni</button>
        <button id="btn-exit">Esci</button>
      </div>
      <p id="exit-msg" class="hint" hidden>
        Il browser non permette di chiudere questa scheda da qui: chiudila a mano.
      </p>
    </main>
  `
  document.getElementById('btn-play').onclick = () => showGame(null)
  document.getElementById('btn-settings').onclick = showSettings
  document.getElementById('btn-exit').onclick = exitGame
}

// joinCode: codice stanza preso dal link d'invito (?stanza=CODICE), oppure null per crearne una nuova.
function showGame(joinCode) {
  startGame(
    app,
    () => {
      try {
        history.replaceState(null, '', location.pathname)
      } catch {
        /* ambienti senza history */
      }
      showMenu()
    },
    { joinCode }
  )
}

function showSettings() {
  app.innerHTML = `
    <main class="screen">
      <h2>Impostazioni</h2>
      <p class="hint">Qui ci saranno le impostazioni (prototipo).</p>
      <div class="buttons">
        <button id="btn-back">Torna al menu</button>
      </div>
    </main>
  `
  document.getElementById('btn-back').onclick = showMenu
}

function exitGame() {
  // I browser permettono window.close() solo su schede aperte via script.
  window.close()
  // Se è ancora aperta, mostriamo un avviso.
  setTimeout(() => {
    const msg = document.getElementById('exit-msg')
    if (msg) msg.hidden = false
  }, 200)
}

// Se si arriva da un link d'invito si va dritti alla stanza.
const invite = new URLSearchParams(location.search).get('stanza')
if (invite) showGame(invite)
else showMenu()
