// Parole segrete per categoria (al posto delle carte).

export const WORDS = {
  Animali: ['leone', 'elefante', 'delfino', 'gatto', 'cane', 'cavallo', 'pinguino', 'giraffa', 'coniglio', 'pappagallo', 'tartaruga', 'scimmia'],
  Cibo: ['pizza', 'lasagna', 'gelato', 'cannolo', 'arancina', 'tiramisù', 'panino', 'sushi', 'cioccolato', 'pasta', 'hamburger', 'focaccia'],
  Luoghi: ['spiaggia', 'scuola', 'ospedale', 'aeroporto', 'cinema', 'montagna', 'castello', 'supermercato', 'biblioteca', 'stadio', 'piscina', 'museo'],
  Oggetti: ['ombrello', 'chiave', 'orologio', 'telefono', 'forbici', 'zaino', 'specchio', 'candela', 'martello', 'occhiali', 'bicicletta', 'lampada'],
  Mestieri: ['pompiere', 'medico', 'cuoco', 'pilota', 'maestro', 'pescatore', 'dentista', 'pittore', 'astronauta', 'idraulico', 'barista', 'contadino'],
  Sport: ['calcio', 'tennis', 'nuoto', 'pallavolo', 'basket', 'ciclismo', 'sci', 'boxe', 'golf', 'rugby', 'scherma', 'surf'],
  Natura: ['vulcano', 'foresta', 'deserto', 'fiume', 'arcobaleno', 'cascata', 'isola', 'tempesta', 'grotta', 'neve', 'oasi', 'luna'],
  Videogiochi: ['minecraft', 'tetris', 'pacman', 'fortnite', 'roblox', 'scratch', 'zelda', 'among us', 'snake', 'pong'],
}

export function pickWord() {
  const cats = Object.keys(WORDS)
  const category = cats[Math.floor(Math.random() * cats.length)]
  const list = WORDS[category]
  const word = list[Math.floor(Math.random() * list.length)]
  return { category, word }
}
