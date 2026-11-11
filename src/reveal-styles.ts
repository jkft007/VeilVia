// The reveal animation names and the ids stored for them. Kept apart from the animations themselves (reveal-anim.ts,
// about 40 kB gzipped) so that creating an image never has to load them.
export type RevealStyle = 'matrix' | 'scramble' | 'typewriter' | 'pixelate' | 'iris' | 'fireworks' | 'curtain' | 'can' | 'flag' | 'moon' | 'plane' | 'swarm' | 'bubbles' | 'ufo' | 'spotlight' | 'jackpot' | 'ink' | 'safe' | 'train' | 'oldtype' | 'printer' | 'ticker' | 'radar' | 'film' | 'parade' | 'asteroids' | 'hearts' | 'flowers' | 'bomb' | 'wizard' | 'minions' | 'snowglobe' | 'rocket' | 'lightning' | 'helicopters' | 'banner' | 'balloons' | 'quill' | 'dominoes' | 'treasure' | 'paperplanes' | 'ghosts' | 'seance' | 'poltergeist' | 'haunted' | 'dragon' | 'panther' | 'roadrunner' | 'genie' | 'fartgun' | 'arrows' | 'tiles' | 'witches' | 'redarrows' | 'pirate' | 'fogwriter' | 'whale' | 'submarine' | 'bomber' | 'kraken' | 'thor' | 'spiders' | 'hatdance' | 'lasers' | 'earthquake' | 'volcano' | 'emoji' | 'sharks' | 'broomball' | 'zombies' | 'dissolve' | 'sandfall' | 'blackhole' | 'hammersmash' | 'shatter' | 'burnaway' | 'shredder' | 'melt' | 'rainwash' | 'acidrain' | 'icemelt' | 'shaken' | 'footsmash' | 'builder' | 'oddbods';
export const STYLES: RevealStyle[] = [
  'matrix', 'scramble', 'typewriter', 'pixelate', 'iris', 'fireworks', 'curtain', 'can', 'flag', 'moon', 'plane',
  'swarm', 'bubbles', 'ufo', 'spotlight', 'jackpot', 'ink', 'safe', 'train', 'oldtype', 'printer',
  'ticker', 'radar', 'film', 'parade', 'asteroids',
  'hearts', 'flowers', 'bomb', 'wizard',
  'minions', 'snowglobe', 'rocket', 'lightning', 'helicopters', 'banner', 'balloons',
  'quill', 'dominoes', 'treasure', 'paperplanes', 'ghosts',
  'seance', 'poltergeist', 'haunted', 'dragon', 'panther', 'roadrunner', 'genie', 'fartgun', 'arrows', 'tiles', 'witches', 'redarrows', 'pirate', 'fogwriter', 'whale', 'submarine', 'bomber', 'kraken', 'thor', 'spiders', 'hatdance', 'lasers', 'earthquake', 'volcano', 'emoji', 'sharks', 'broomball', 'zombies',
  'dissolve', 'sandfall', 'blackhole', 'hammersmash', 'shatter', 'burnaway', 'shredder', 'melt', 'rainwash', 'acidrain', 'icemelt', 'shaken', 'footsmash', 'builder', 'oddbods',
];

// Stored in the sender's choice of animation instead of a style: show the message at once, with no animation.
export const NO_ANIM = 255;

// The position in STYLES (plus one) is stored inside encrypted images, so only ever append new styles.
export const styleToId = (s: RevealStyle): number => STYLES.indexOf(s) + 1;
export const idToStyle = (id: number | undefined): RevealStyle | undefined => (id ? STYLES[id - 1] : undefined);
