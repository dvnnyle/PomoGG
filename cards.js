// cards.js
const { createCanvas, loadImage } = require('canvas');
const axios = require('axios');
const { supabase } = require('./database');
const { cardSets, PRELOAD_IMAGES, PICK_POOL_SIZE, PACK_POOL_SIZE, REFILL_THRESHOLD } = require('./config');

// Card storage
let cards = [];
const cardMap = new Map();

// Image cache
const imageCache = new Map();
const combinedImageCache = new Map();

// Pre-generated pick and pack pools
const pickPool = [];
const packPool = [];

// Generate unique card instance ID (po1234 format)
function generateCardInstanceId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'po';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Get random card
function randomCard() {
  if (!cards.length) return null;
  const i = Math.floor(Math.random() * cards.length);
  return cards[i];
}

// Format card names: remove underscores and uppercase
function formatCardName(name) {
  if (!name) return 'Unknown';
  return name
    .replace(/_/g, ' ')
    .toUpperCase();
}

// Load all files from all buckets
async function loadCardsFromSupabase() {
  console.log('Loading cards from Supabase...');
  cards.length = 0; // Clear array without breaking reference

  for (const set of cardSets) {
    const { data, error } = await supabase
      .storage
      .from(set.bucket)
      .list('', { limit: 1000, sortBy: { column: 'name', order: 'asc' } });

    if (error) {
      console.error(`Error loading cards from ${set.bucket}:`, error);
      continue;
    }

    const imageFiles = (data || []).filter(file =>
      file.name.endsWith('.png') ||
      file.name.endsWith('.jpg') ||
      file.name.endsWith('.jpeg') ||
      file.name.endsWith('.gif')
    );

    const setCards = imageFiles.map(file => {
      const id = file.name.split('.')[0];
      
      const parts = id.split('-');
      const filteredParts = parts.filter(part => {
        const lower = part.toLowerCase();
        // Skip pure numbers
        if (/^\d+$/.test(part)) return false;
        // Skip language codes (en_US, en, fr, ja, etc)
        if (/^[a-z]{2}(_[A-Z]{2})?$/i.test(part)) return false;
        // Skip set codes (SWSH4, B2, XY1, etc - letters followed by numbers)
        if (/^[a-z]+\d+$/i.test(part)) return false;
        // Skip single letters
        if (part.length === 1) return false;
        // Skip common set identifiers (expanded list)
        const skipWords = ['promo', 'swsh', 'sm', 'xy', 'bw', 'dp', 'hgss', 'pl', 'ex', 'base', 'set', 'series'];
        if (skipWords.includes(lower)) return false;
        return true;
      });
      
      const name = filteredParts
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      return {
        id,
        name: name || 'Unknown Card',
        rarity: 'common',
        set: set.displayName,
        imageUrl: `${process.env.SUPABASE_URL}/storage/v1/object/public/${set.bucket}/${file.name}`
      };
    });

    cards.push(...setCards);
    console.log(`✅ Loaded ${setCards.length} cards from ${set.displayName}`);
  }

  cardMap.clear();
  cards.forEach(card => cardMap.set(card.id, card));

  console.log(`✅ Total: ${cards.length} cards loaded from all sets`);
  
  if (PRELOAD_IMAGES) {
    console.log('⏳ Preloading all card images into cache...');
    const preloadStart = Date.now();
    
    const batchSize = 10;
    for (let i = 0; i < cards.length; i += batchSize) {
      const batch = cards.slice(i, i + batchSize);
      await Promise.all(batch.map(card => fetchAndCacheImage(card.imageUrl)));
      console.log(`   Cached ${Math.min(i + batchSize, cards.length)}/${cards.length} images...`);
    }
    
    const preloadTime = ((Date.now() - preloadStart) / 1000).toFixed(2);
    console.log(`✅ All images preloaded in ${preloadTime}s - pick commands will be instant!`);
  } else {
    console.log('ℹ️  Image preloading disabled - images will load on demand');
  }

  await generatePickPool();
  await generatePackPool();
}

// Fetch and cache image
async function fetchAndCacheImage(url) {
  if (imageCache.has(url)) {
    return imageCache.get(url);
  }

  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  const image = await loadImage(buffer);
  
  imageCache.set(url, image);
  
  return image;
}

// Combine 3 card images horizontally
async function combineCardImages(card1Url, card2Url, card3Url) {
  try {
    const cacheKey = `${card1Url}|${card2Url}|${card3Url}`;
    
    if (combinedImageCache.has(cacheKey)) {
      return combinedImageCache.get(cacheKey);
    }

    const [img1, img2, img3] = await Promise.all([
      fetchAndCacheImage(card1Url),
      fetchAndCacheImage(card2Url),
      fetchAndCacheImage(card3Url)
    ]);

    const targetWidth = 500;
    const targetHeight = 700;
    const spacing = 50;
    
    const canvas = createCanvas(targetWidth * 3 + spacing * 2, targetHeight);
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(img1, 0, 0, targetWidth, targetHeight);
    ctx.drawImage(img2, targetWidth + spacing, 0, targetWidth, targetHeight);
    ctx.drawImage(img3, (targetWidth + spacing) * 2, 0, targetWidth, targetHeight);

    const buffer = canvas.toBuffer('image/png');
    
    combinedImageCache.set(cacheKey, buffer);
    
    return buffer;
  } catch (error) {
    console.error('Error combining images:', error);
    return null;
  }
}

// Combine 5 card images horizontally
async function combinePackImages(urls) {
  try {
    const cacheKey = urls.join('|');
    
    if (combinedImageCache.has(cacheKey)) {
      return combinedImageCache.get(cacheKey);
    }

    const images = await Promise.all(urls.map(url => fetchAndCacheImage(url)));

    const targetWidth = 400;
    const targetHeight = 560;
    const spacing = 30;
    
    const canvas = createCanvas(targetWidth * 5 + spacing * 4, targetHeight);
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    images.forEach((img, i) => {
      const x = i * (targetWidth + spacing);
      ctx.drawImage(img, x, 0, targetWidth, targetHeight);
    });

    const buffer = canvas.toBuffer('image/png');
    
    combinedImageCache.set(cacheKey, buffer);
    
    return buffer;
  } catch (error) {
    console.error('Error combining pack images:', error);
    return null;
  }
}

// Pre-generate pick combinations
async function generatePickPool() {
  console.log(`⏳ Pre-generating ${PICK_POOL_SIZE} pick combinations...`);
  const startTime = Date.now();
  
  for (let i = 0; i < PICK_POOL_SIZE; i++) {
    const choices = [];
    for (let j = 0; j < 3; j++) {
      const card = randomCard();
      if (card) choices.push(card);
    }
    
    if (choices.length === 3) {
      const combinedImageBuffer = await combineCardImages(
        choices[0].imageUrl,
        choices[1].imageUrl,
        choices[2].imageUrl
      );
      
      if (combinedImageBuffer) {
        pickPool.push({ choices, imageBuffer: combinedImageBuffer });
        console.log(`   Generated pick ${i + 1}/${PICK_POOL_SIZE}...`);
      }
    }
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Pick pool ready with ${pickPool.length} combinations (${elapsed}s)`);
}

// Pre-generate pack combinations
async function generatePackPool() {
  console.log(`⏳ Pre-generating ${PACK_POOL_SIZE} pack combinations...`);
  const startTime = Date.now();
  
  for (let i = 0; i < PACK_POOL_SIZE; i++) {
    const cardList = [];
    for (let j = 0; j < 5; j++) {
      const card = randomCard();
      if (card) {
        const instanceId = generateCardInstanceId();
        cardList.push({ ...card, instance_id: instanceId });
      }
    }
    
    if (cardList.length === 5) {
      const imageUrls = cardList.map(c => c.imageUrl);
      const combinedImageBuffer = await combinePackImages(imageUrls);
      
      if (combinedImageBuffer) {
        packPool.push({ cards: cardList, imageBuffer: combinedImageBuffer });
        console.log(`   Generated pack ${i + 1}/${PACK_POOL_SIZE}...`);
      }
    }
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Pack pool ready with ${packPool.length} combinations (${elapsed}s)`);
}

// Get a pick from the pool and refill if needed
function getPickFromPool() {
  if (pickPool.length === 0) return null;
  
  const pick = pickPool.shift();
  
  if (pickPool.length <= REFILL_THRESHOLD) {
    console.log('🔄 Pick pool low, refilling in background...');
    generatePickPool().catch(err => console.error('Error refilling pick pool:', err));
  }
  
  return pick;
}

// Get a pack from the pool and refill if needed
function getPackFromPool() {
  if (packPool.length === 0) return null;
  
  const pack = packPool.shift();
  
  if (packPool.length <= REFILL_THRESHOLD) {
    console.log('🔄 Pack pool low, refilling in background...');
    generatePackPool().catch(err => console.error('Error refilling pack pool:', err));
  }
  
  return pack;
}

module.exports = {
  cards,
  cardMap,
  loadCardsFromSupabase,
  randomCard,
  generateCardInstanceId,
  formatCardName,
  getPickFromPool,
  getPackFromPool
};
