// config.js
require('dotenv').config();

const TEST_MODE = process.env.TEST_MODE === 'true';
const PRELOAD_IMAGES = process.env.PRELOAD_IMAGES === 'true';

// Cooldowns (ms)
const DRAW_COOLDOWN = TEST_MODE ? 0 : 15 * 60 * 1000;   // 0s vs 15min
const PACK_COOLDOWN = TEST_MODE ? 0 : 24 * 60 * 60 * 1000;   // 0s vs 24hr
const PICK_COOLDOWN = TEST_MODE ? 0 : 30 * 60 * 1000;  // 0s vs 30min

// Pool configuration
const PICK_POOL_SIZE = 20;
const PACK_POOL_SIZE = 20;
const REFILL_THRESHOLD = 15;

// Card sets
const cardSets = [
  { bucket: 'baseSet2', displayName: 'Base Set 2' },
  { bucket: 'crowZenith', displayName: 'Crown Zenith' },
  { bucket: 'vividVoltage', displayName: 'Vivid Voltage' },
  { bucket: 'evolvingSkies', displayName: 'Evolving Skies' },
  { bucket: 'fusionStrike', displayName: 'Fusion Strike' },
  { bucket: 'swordShieldPromos', displayName: 'Sword & Shield Promos' },
  { bucket: 'evolutions', displayName: 'Evolution' },
  { bucket: 'ultraPrism', displayName: 'Ultra Prism' },
  { bucket: 'darknessAblaze', displayName: 'Darkness Ablaze' },
  { bucket: 'blackWhite', displayName: 'Black & White' },
  { bucket: 'diamondPearl', displayName: 'Diamond & Pearl' },
  { bucket: 'astralRadiance', displayName: 'Astral Radiance' }
];

console.log('TEST_MODE:', TEST_MODE);
console.log('PRELOAD_IMAGES:', PRELOAD_IMAGES);
console.log('Draw cooldown:', DRAW_COOLDOWN, 'ms');
console.log('Pack cooldown:', PACK_COOLDOWN, 'ms');

module.exports = {
  TEST_MODE,
  PRELOAD_IMAGES,
  DRAW_COOLDOWN,
  PACK_COOLDOWN,
  PICK_COOLDOWN,
  PICK_POOL_SIZE,
  PACK_POOL_SIZE,
  REFILL_THRESHOLD,
  cardSets
};
