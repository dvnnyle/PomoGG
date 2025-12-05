// index.js
require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const { createCanvas, loadImage } = require('canvas');
const axios = require('axios');
const { AttachmentBuilder } = require('discord.js');

// ------------------- DISCORD CLIENT -------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ------------------- CONFIG -------------------
const TEST_MODE = process.env.TEST_MODE === 'true';
const PRELOAD_IMAGES = process.env.PRELOAD_IMAGES === 'true'; // Enable/disable image preloading

// cooldowns (ms)
const DRAW_COOLDOWN = TEST_MODE ? 0 : 15 * 60 * 1000;   // 0s vs 15min
const PACK_COOLDOWN = TEST_MODE ? 0 : 10 * 60 * 1000;   // 0s vs 10min
const PICK_COOLDOWN = TEST_MODE ? 0 : 30 * 60 * 1000;  // 0s vs 30min

console.log('TEST_MODE:', TEST_MODE);
console.log('PRELOAD_IMAGES:', PRELOAD_IMAGES);
console.log('Draw cooldown:', DRAW_COOLDOWN, 'ms');
console.log('Pack cooldown:', PACK_COOLDOWN, 'ms');

// ------------------- SUPABASE -------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// This will hold all card definitions loaded from Supabase
let cards = [];

// Configuration for all card sets
const cardSets = [
  { bucket: 'baseSet2', displayName: 'Base Set 2' },
  { bucket: 'crowZenith', displayName: 'Crown Zenith' },
  { bucket: 'vividVoltage', displayName: 'Vivid Voltage' },
  // { bucket: 'whiteFlare', displayName: 'White Flare' }, // Temporarily disabled
  // { bucket: 'BlackBolt', displayName: 'Black Bolt' }, // Temporarily disabled
  { bucket: 'evolvingSkies', displayName: 'Evolving Skies' }
];

// Load all files from all buckets and convert them to card objects
async function loadCardsFromSupabase() {
  console.log('Loading cards from Supabase...');
  cards = [];

  for (const set of cardSets) {
    const { data, error } = await supabase
      .storage
      .from(set.bucket)
      .list('', { limit: 1000, sortBy: { column: 'name', order: 'asc' } });

    if (error) {
      console.error(`Error loading cards from ${set.bucket}:`, error);
      console.error('Full error details:', JSON.stringify(error, null, 2));
      continue;
    }

    // Filter for image files only
    const imageFiles = (data || []).filter(file =>
      file.name.endsWith('.png') ||
      file.name.endsWith('.jpg') ||
      file.name.endsWith('.jpeg') ||
      file.name.endsWith('.gif')
    );

    const setCards = imageFiles.map(file => {
      const id = file.name.split('.')[0];
      
      // Parse the card name intelligently
      // Filter out: language codes (en_US, fr, etc), set codes (SWSH4, b2, etc), numbers
      const parts = id.split('-');
      const filteredParts = parts.filter(part => {
        // Skip if it's a number
        if (/^\d+$/.test(part)) return false;
        // Skip language codes (en_US, en, fr, ja, etc)
        if (/^[a-z]{2}(_[A-Z]{2})?$/i.test(part)) return false;
        // Skip set codes (SWSH4, B2, XY1, etc - letters followed by numbers)
        if (/^[a-z]+\d+$/i.test(part)) return false;
        // Skip single letters
        if (part.length === 1) return false;
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

  // Build lookup map for fast inventory access
  cardMap.clear();
  cards.forEach(card => cardMap.set(card.id, card));

  console.log(`✅ Total: ${cards.length} cards loaded from all sets`);
  
  // Preload all images into cache for instant access (if enabled)
  if (PRELOAD_IMAGES) {
    console.log('⏳ Preloading all card images into cache...');
    const preloadStart = Date.now();
    
    // Load images in batches to avoid overwhelming the system
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
}

// ------------------- DATABASE FUNCTIONS -------------------
// In-memory cache for active sessions
const userData = {};

// Load user data from Supabase
async function getUserData(userId) {
  // Check memory cache first
  if (userData[userId]) {
    return userData[userId];
  }

  try {
    // Load user from database
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (userError && userError.code !== 'PGRST116') { // PGRST116 = not found
      console.error('Error loading user:', userError);
    }

    // Load inventory from database
    const { data: inventory, error: invError } = await supabase
      .from('inventory')
      .select('*')
      .eq('user_id', userId)
      .order('obtained_at', { ascending: true });

    if (invError) {
      console.error('Error loading inventory:', invError);
    }

    // Create user data object
    userData[userId] = {
      inventory: inventory || [],
      lastDraw: user?.last_draw || 0,
      lastPack: user?.last_pack || 0,
      lastPick: user?.last_pick || 0,
      pickChoices: []
    };

    // If user doesn't exist in DB, create them
    if (!user) {
      await supabase.from('users').insert({
        user_id: userId,
        last_draw: 0,
        last_pack: 0,
        last_pick: 0
      });
    }

    return userData[userId];
  } catch (error) {
    console.error('Error in getUserData:', error);
    // Fallback to empty data
    userData[userId] = {
      inventory: [],
      lastDraw: 0,
      lastPack: 0,
      lastPick: 0,
      pickChoices: []
    };
    return userData[userId];
  }
}

// Save user cooldowns to database
async function saveUserCooldowns(userId, data) {
  try {
    await supabase
      .from('users')
      .upsert({
        user_id: userId,
        last_draw: data.lastDraw,
        last_pack: data.lastPack,
        last_pick: data.lastPick
      });
  } catch (error) {
    console.error('Error saving cooldowns:', error);
  }
}

// Add card to user's inventory in database
async function addCardToInventory(userId, cardId, obtainedAt, instanceId) {
  try {
    const { error } = await supabase
      .from('inventory')
      .insert({
        user_id: userId,
        card_id: cardId,
        obtained_at: obtainedAt,
        instance_id: instanceId
      });

    if (error) {
      console.error('Error adding card to inventory:', error);
    }
  } catch (error) {
    console.error('Error in addCardToInventory:', error);
  }
}

function randomCard() {
  if (!cards.length) return null;
  const i = Math.floor(Math.random() * cards.length);
  return cards[i];
}

// Generate unique card instance ID (po1234 format)
function generateCardInstanceId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'po';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Create a card lookup map for faster inventory access
const cardMap = new Map();

// Image cache to avoid re-downloading
const imageCache = new Map();

// Combined image cache (for pick command)
const combinedImageCache = new Map();

// Server configuration (guild_id -> channel_id)
const serverConfig = new Map();

// Load server configurations from database
async function loadServerConfigs() {
  try {
    const { data, error } = await supabase
      .from('server_config')
      .select('*');
    
    if (error) {
      console.error('Error loading server configs:', error);
      return;
    }
    
    if (data) {
      data.forEach(config => {
        serverConfig.set(config.guild_id, config.channel_id);
      });
      console.log(`Loaded ${data.length} server configurations`);
    }
  } catch (error) {
    console.error('Error in loadServerConfigs:', error);
  }
}

// Set channel for a guild
async function setGuildChannel(guildId, channelId) {
  try {
    serverConfig.set(guildId, channelId);
    
    await supabase
      .from('server_config')
      .upsert({
        guild_id: guildId,
        channel_id: channelId
      });
    
    return true;
  } catch (error) {
    console.error('Error setting guild channel:', error);
    return false;
  }
}

// Check if command is allowed in this channel
function isAllowedChannel(guildId, channelId) {
  // If no config set for this guild, allow all channels
  if (!serverConfig.has(guildId)) return true;
  
  // Check if this channel matches the configured channel
  return serverConfig.get(guildId) === channelId;
}

// Function to fetch and cache image
async function fetchAndCacheImage(url) {
  // Check if already cached
  if (imageCache.has(url)) {
    return imageCache.get(url);
  }

  // Fetch and cache
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  const image = await loadImage(buffer);
  
  // Store in cache
  imageCache.set(url, image);
  
  return image;
}

// Function to combine 3 card images horizontally
async function combineCardImages(card1Url, card2Url, card3Url) {
  try {
    // Create cache key from the 3 URLs
    const cacheKey = `${card1Url}|${card2Url}|${card3Url}`;
    
    // Check if this combination is already cached
    if (combinedImageCache.has(cacheKey)) {
      return combinedImageCache.get(cacheKey);
    }

    // Fetch all 3 images (with caching)
    const [img1, img2, img3] = await Promise.all([
      fetchAndCacheImage(card1Url),
      fetchAndCacheImage(card2Url),
      fetchAndCacheImage(card3Url)
    ]);

    // Balanced size for better Discord preview
    const targetWidth = 500;
    const targetHeight = 700;
    const spacing = 50; // Space between cards
    
    const canvas = createCanvas(targetWidth * 3 + spacing * 2, targetHeight);
    const ctx = canvas.getContext('2d');

    // Transparent background (no white)
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw all 3 images side by side with spacing
    ctx.drawImage(img1, 0, 0, targetWidth, targetHeight);
    ctx.drawImage(img2, targetWidth + spacing, 0, targetWidth, targetHeight);
    ctx.drawImage(img3, (targetWidth + spacing) * 2, 0, targetWidth, targetHeight);

    const buffer = canvas.toBuffer('image/png');
    
    // Cache the combined result
    combinedImageCache.set(cacheKey, buffer);
    
    return buffer;
  } catch (error) {
    console.error('Error combining images:', error);
    return null;
  }
}

function formatInventory(inv) {
  if (!inv.length) return 'You have no cards yet 😢';

  return inv
    .map((entry, i) => {
      const cardId = entry.card_id || entry.cardId; // Support both formats
      const card = cardMap.get(cardId) || cards.find(c => c.id === cardId);
      const name = card ? card.name : 'Unknown';
      const rarity = card ? card.rarity : '???';
      const ownerId = entry.instance_id || 'N/A';
      return `#${i} - **${name}** (${rarity}) \`${ownerId}\``;
    })
    .join('\n');
}

function formatBinderEmbed(inv, page = 0) {
  const CARDS_PER_PAGE = 10;
  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('📖 Your Card Binder')
    .setTimestamp();

  if (!inv.length) {
    embed.setDescription('Your binder is empty. Start collecting cards!');
    return { embed, totalPages: 1 };
  }

  // Group cards by set
  const bySet = {};
  inv.forEach((entry, i) => {
    const cardId = entry.card_id || entry.cardId;
    const card = cardMap.get(cardId) || cards.find(c => c.id === cardId);
    if (card) {
      if (!bySet[card.set]) bySet[card.set] = [];
      bySet[card.set].push({ index: i, card });
    }
  });

  // Flatten all cards for pagination
  const allCards = [];
  for (const [setName, items] of Object.entries(bySet)) {
    allCards.push({ type: 'header', setName, count: items.length });
    allCards.push(...items.map(item => ({ type: 'card', ...item, entry: inv[item.index] })));
  }

  const totalPages = Math.ceil(allCards.length / CARDS_PER_PAGE);
  const startIdx = page * CARDS_PER_PAGE;
  const endIdx = startIdx + CARDS_PER_PAGE;
  const pageCards = allCards.slice(startIdx, endIdx);

  let description = '';
  for (const item of pageCards) {
    if (item.type === 'header') {
      description += `\n**${item.setName}** (${item.count})\n`;
    } else if (item.type === 'card') {
      const ownerId = item.entry?.instance_id || 'N/A';
      description += `#${item.index} ${item.card.name} (${item.card.rarity}) \`${ownerId}\`\n`;
    }
  }

  embed.setDescription(description || 'No cards on this page.');
  embed.setFooter({ text: `Page ${page + 1}/${totalPages} | Total Cards: ${inv.length}` });
  
  return { embed, totalPages };
}

function msToNice(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ------------------- SLASH COMMANDS -------------------
const commands = [
  new SlashCommandBuilder()
    .setName('draw')
    .setDescription('Draw 1 card (every 15 minutes, shorter in test mode)'),

  new SlashCommandBuilder()
    .setName('pack')
    .setDescription('Open 1 pack of 5 cards (every 30 minutes, shorter in test mode)'),

  new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Show your card collection'),

  new SlashCommandBuilder()
    .setName('trash')
    .setDescription('Trash a card from your inventory')
    .addIntegerOption(option =>
      option.setName('index')
        .setDescription('Card index from /inventory (starting at 0)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('reset_me')
    .setDescription('Reset your data (testing only)'),

  new SlashCommandBuilder()
    .setName('menu')
    .setDescription('Show the card game menu with buttons'),

  new SlashCommandBuilder()
    .setName('pick')
    .setDescription('Choose 1 card from 3 options (every 30 minutes, shorter in test mode)'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),

  new SlashCommandBuilder()
    .setName('binder')
    .setDescription('View your card collection in a organized binder format'),

  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Trade a card to another trainer')
    .addStringOption(option =>
      option.setName('card')
        .setDescription('The card ID to trade (e.g., pox1lj)')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('trainer')
        .setDescription('The trainer to trade with')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('view')
    .setDescription('View a specific card by its card ID')
    .addStringOption(option =>
      option.setName('card')
        .setDescription('The card ID to view (e.g., pox1lj)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for cards by name')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Card name to search for')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel where bot commands are allowed (Admin only)')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to allow commands in')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(0x8), // Administrator permission

  new SlashCommandBuilder()
    .setName('channelinfo')
    .setDescription('Show which channel is configured for bot commands')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered!');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
}

// ------------------- BOT EVENTS -------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadServerConfigs();
});

// Handle text commands
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  
  const command = message.content.toLowerCase().trim();
  
  // Check if it's a valid command
  if (!command.startsWith('kd') && command !== 'pick' && command !== 'pk') return;

  // Check if command is allowed in this channel
  if (!isAllowedChannel(message.guild?.id, message.channel.id)) {
    return message.reply('❌ Commands are not allowed in this channel. Ask an admin to use `/setchannel` to configure.');
  }

  const user = message.author;
  const now = Date.now();
  const data = await getUserData(user.id);

  // kd (default to draw)
  if (command === 'kd' || command === 'kd draw' || command === 'kd d') {
    const elapsed = now - data.lastDraw;
    if (elapsed < DRAW_COOLDOWN) {
      const remaining = DRAW_COOLDOWN - elapsed;
      return message.reply(`⏳ You can draw again in **${msToNice(remaining)}**.`);
    }

    const card = randomCard();
    if (!card) return message.reply('❌ No cards available.');

    // Send loading message
    const loadingMsg = await message.reply('⏳ Drawing card...');

    const instanceId = generateCardInstanceId();
    data.inventory.push({ card_id: card.id, obtained_at: now, instance_id: instanceId });
    data.lastDraw = now;
    
    // Save to database
    await addCardToInventory(user.id, card.id, now, instanceId);
    await saveUserCooldowns(user.id, data);

    // Extract card name from the full name (e.g., "Onix Base Set 2 B2 84" -> "Onix")
    const cardNameParts = card.name.split(' ');
    const cardName = cardNameParts[0]; // First word is the Pokemon name
    const quality = `PSA ${Math.floor(Math.random() * 10) + 1}`; // Random PSA 1-10

    return loadingMsg.edit({
      content: `## ${cardName}\n**Set:** ${card.set} | **Quality:** ${quality}`,
      files: [card.imageUrl]
    });
  }

  // kd pack
  if (command === 'kd pack' || command === 'kd p') {
    const elapsed = now - data.lastPack;
    if (elapsed < PACK_COOLDOWN) {
      const remaining = PACK_COOLDOWN - elapsed;
      return message.reply(`⏳ You can open another pack in **${msToNice(remaining)}**.`);
    }

    // Send loading message
    const loadingMsg = await message.reply('⏳ Opening pack...');

    const packSize = 5;
    const pulled = [];
    for (let i = 0; i < packSize; i++) {
      const card = randomCard();
      if (!card) break;
      const instanceId = generateCardInstanceId();
      pulled.push(card);
      data.inventory.push({ card_id: card.id, obtained_at: now, instance_id: instanceId });
      await addCardToInventory(user.id, card.id, now, instanceId);
    }
    data.lastPack = now;
    await saveUserCooldowns(user.id, data);

    const summary = pulled.map(c => `- **${c.name}** (${c.rarity})`).join('\n');
    return loadingMsg.edit(`🃏 You opened a pack and got:\n${summary}`);
  }

  // kd inventory
  if (command === 'kd inventory' || command === 'kd inv' || command === 'kd i') {
    const text = formatInventory(data.inventory);
    return message.reply(text);
  }

  // kd binder
  if (command === 'kd binder' || command === 'kd b' || command === 'binder') {
    const page = 0;
    const { embed, totalPages } = formatBinderEmbed(data.inventory, page);
    
    if (totalPages <= 1) {
      return message.reply({ embeds: [embed] });
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('binder_prev_0')
          .setLabel('⬅️ Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('binder_next_0')
          .setLabel('Next ➡️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(totalPages === 1)
      );

    return message.reply({ embeds: [embed], components: [row] });
  }

  // kd pick / pk
  if (command === 'kd pick' || command === 'kd pk' || command === 'pk' || command === 'pick') {
    const elapsed = now - data.lastPick;
    if (elapsed < PICK_COOLDOWN) {
      const remaining = PICK_COOLDOWN - elapsed;
      return message.reply(`⏳ You can pick again in **${msToNice(remaining)}**.`);
    }

    // Draw 3 random cards
    const choices = [];
    for (let i = 0; i < 3; i++) {
      const card = randomCard();
      if (!card) break;
      choices.push(card);
    }

    if (choices.length < 3) {
      return message.reply('❌ Not enough cards available.');
    }

    data.lastPick = now;
    data.pickChoices = choices;
    await saveUserCooldowns(user.id, data);

    // Send loading message
    const loadingMsg = await message.reply('⏳ Loading cards...');

    // Combine the 3 images horizontally
    const combinedImageBuffer = await combineCardImages(
      choices[0].imageUrl,
      choices[1].imageUrl,
      choices[2].imageUrl
    );

    if (!combinedImageBuffer) {
      return loadingMsg.edit('❌ Failed to load card images.');
    }

    const attachment = new AttachmentBuilder(combinedImageBuffer, { name: 'cards.png' });

    const content = '🎴 **Pick one card to keep:**';

    // Create buttons for selection
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('btn_pick_0')
          .setLabel('1️⃣')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('btn_pick_1')
          .setLabel('2️⃣')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('btn_pick_2')
          .setLabel('3️⃣')
          .setStyle(ButtonStyle.Primary)
      );

    return loadingMsg.edit({
      content: content,
      files: [attachment],
      components: [row]
    });
  }

  // kd help
  if (command === 'kd help' || command === 'help') {
    return message.reply(
      '**Card Game Commands:**\n\n' +
      '**Text Commands:**\n' +
      '`kd` or `kd draw` - Draw a card (5 min cooldown)\n' +
      '`kd pack` or `kd p` - Open a pack of 5 cards (10 min cooldown)\n' +
      '`pick` or `pk` - Pick 1 from 3 cards (30 min cooldown)\n' +
      '`kd inventory`, `kd inv`, or `kd i` - View your collection\n' +
      '`binder`, `kd binder`, or `kd b` - View organized binder\n' +
      '`help` or `kd help` - Show this help\n\n' +
      '**Slash Commands:**\n' +
      '`/draw` - Draw a card\n' +
      '`/pack` - Open a pack\n' +
      '`/pick` - Pick from 3 cards\n' +
      '`/inventory` - View your collection\n' +
      '`/binder` - View organized binder\n' +
      '`/menu` - Interactive button menu\n' +
      '`/search <name>` - Search for cards by name\n' +
      '`/view <card>` - View a specific card\n' +
      '`/trade <card> <@trainer>` - Trade a card to another trainer\n' +
      '`/trash <index>` - Remove a card\n' +
      '`/reset_me` - Reset your data (testing)\n' +
      '`/help` - Show this help'
    );
  }
});

client.on('interactionCreate', async interaction => {
  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    // Handle /setchannel command
    if (interaction.commandName === 'setchannel') {
      const channel = interaction.options.getChannel('channel');
      const success = await setGuildChannel(interaction.guild.id, channel.id);
      
      if (success) {
        return interaction.reply({
          content: `✅ Bot commands are now restricted to <#${channel.id}>`,
          ephemeral: true
        });
      } else {
        return interaction.reply({
          content: '❌ Failed to set channel configuration.',
          ephemeral: true
        });
      }
    }

    // Handle /channelinfo command
    if (interaction.commandName === 'channelinfo') {
      const guildId = interaction.guild?.id;
      const channelId = serverConfig.get(guildId);
      
      if (!channelId) {
        return interaction.reply({
          content: '📋 No channel restriction set. Commands work in all channels.\n\n*Admins can use `/setchannel` to restrict to a specific channel.*',
          ephemeral: true
        });
      }
      
      return interaction.reply({
        content: `📋 Bot commands are restricted to: <#${channelId}>\n\n*Admins can use \`/setchannel\` to change it.*`,
        ephemeral: true
      });
    }

    // Check if command is allowed in this channel (except setchannel and channelinfo)
    const exemptCommands = ['setchannel', 'channelinfo'];
    if (!exemptCommands.includes(interaction.commandName) && !isAllowedChannel(interaction.guild?.id, interaction.channel.id)) {
      return interaction.reply({
        content: '❌ Commands are not allowed in this channel. Ask an admin to use `/setchannel` to configure.',
        ephemeral: true
      });
    }
  }

  // Handle button clicks
  if (interaction.isButton()) {
    // Check if button interactions are allowed in this channel
    if (!isAllowedChannel(interaction.guild?.id, interaction.channel.id)) {
      return interaction.reply({
        content: '❌ Commands are not allowed in this channel.',
        ephemeral: true
      });
    }
    const { customId, user } = interaction;
    const now = Date.now();
    const data = await getUserData(user.id);

    if (customId === 'btn_draw') {
      const elapsed = now - data.lastDraw;
      if (elapsed < DRAW_COOLDOWN) {
        const remaining = DRAW_COOLDOWN - elapsed;
        return interaction.reply({
          content: `⏳ You can draw again in **${msToNice(remaining)}**.`,
          ephemeral: true
        });
      }

      const card = randomCard();
      if (!card) return interaction.reply({ content: '❌ No cards available.', ephemeral: true });

      const instanceId = generateCardInstanceId();
      data.inventory.push({ card_id: card.id, obtained_at: now, instance_id: instanceId });
      data.lastDraw = now;
      await addCardToInventory(user.id, card.id, now, instanceId);
      await saveUserCooldowns(user.id, data);

      await interaction.deferReply();

      const cardNameParts = card.name.split(' ');
      const cardName = cardNameParts[0];
      const quality = `PSA ${Math.floor(Math.random() * 10) + 1}`;

      return interaction.editReply({
        content: `## ${cardName}\n**Set:** ${card.set} | **Quality:** ${quality}`,
        files: [card.imageUrl]
      });
    }

    if (customId === 'btn_pack') {
      const elapsed = now - data.lastPack;
      if (elapsed < PACK_COOLDOWN) {
        const remaining = PACK_COOLDOWN - elapsed;
        return interaction.reply({
          content: `⏳ You can open another pack in **${msToNice(remaining)}**.`,
          ephemeral: true
        });
      }

      const packSize = 5;
      const pulled = [];
      for (let i = 0; i < packSize; i++) {
        const card = randomCard();
        if (!card) break;
        const instanceId = generateCardInstanceId();
        pulled.push(card);
        data.inventory.push({ cardId: card.id, obtainedAt: now, instance_id: instanceId });
        await addCardToInventory(user.id, card.id, now, instanceId);
      }
      data.lastPack = now;
      await saveUserCooldowns(user.id, data);

      const summary = pulled.map(c => `- **${c.name}** (${c.rarity})`).join('\n');
      return interaction.reply(`🃏 You opened a pack and got:\n${summary}`);
    }

    if (customId === 'btn_inventory') {
      const text = formatInventory(data.inventory);
      return interaction.reply({ content: text, ephemeral: true });
    }

    // Handle trade accept/decline
    if (customId.startsWith('trade_accept_') || customId.startsWith('trade_decline_')) {
      const parts = customId.split('_');
      const action = parts[1]; // 'accept' or 'decline'
      const senderId = parts[2];
      const receiverId = parts[3];
      const instanceId = parts[4];

      // Only the receiver can accept/decline
      if (user.id !== receiverId) {
        return interaction.reply({
          content: '❌ This trade is not for you!',
          ephemeral: true
        });
      }

      if (action === 'decline') {
        return interaction.update({
          content: `❌ <@${receiverId}> declined the trade.`,
          components: []
        });
      }

      // Accept trade - transfer card
      const senderData = await getUserData(senderId);
      const receiverData = await getUserData(receiverId);

      // Find card in sender's inventory
      const cardIndex = senderData.inventory.findIndex(entry => {
        const entryInstanceId = entry.instance_id || entry.instanceId;
        return entryInstanceId === instanceId;
      });

      if (cardIndex === -1) {
        return interaction.update({
          content: '❌ Trade failed: Card no longer exists in sender\'s inventory.',
          components: []
        });
      }

      const cardEntry = senderData.inventory[cardIndex];
      const cardId = cardEntry.card_id || cardEntry.cardId;
      const card = cardMap.get(cardId) || cards.find(c => c.id === cardId);
      const cardName = card ? card.name : 'Unknown';

      // Remove from sender
      senderData.inventory.splice(cardIndex, 1);

      // Add to receiver
      const now = Date.now();
      receiverData.inventory.push({
        card_id: cardId,
        cardId: cardId,
        obtained_at: now,
        obtainedAt: now,
        instance_id: instanceId
      });

      // Update database - delete from sender
      const { error: deleteError } = await supabase
        .from('inventory')
        .delete()
        .eq('user_id', senderId)
        .eq('instance_id', instanceId)
        .limit(1);

      if (deleteError) {
        console.error('Error deleting card from sender:', deleteError);
      }

      // Update database - add to receiver
      await addCardToInventory(receiverId, cardId, now, instanceId);

      return interaction.update({
        content: `✅ Trade completed! <@${senderId}> traded **${cardName}** (\`${instanceId}\`) to <@${receiverId}>`,
        components: []
      });
    }

    // Handle binder pagination
    if (customId.startsWith('binder_prev_') || customId.startsWith('binder_next_')) {
      const currentPage = parseInt(customId.split('_')[2]);
      const isNext = customId.startsWith('binder_next_');
      const newPage = isNext ? currentPage + 1 : currentPage - 1;
      
      const { embed, totalPages } = formatBinderEmbed(data.inventory, newPage);
      
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`binder_prev_${newPage}`)
            .setLabel('⬅️ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(newPage === 0),
          new ButtonBuilder()
            .setCustomId(`binder_next_${newPage}`)
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(newPage >= totalPages - 1)
        );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // Handle search pagination
    if (customId.startsWith('search_prev_') || customId.startsWith('search_next_')) {
      const parts = customId.split('_');
      const currentPage = parseInt(parts[2]);
      const searchQuery = parts.slice(3).join('_');
      const isNext = customId.startsWith('search_next_');
      const newPage = isNext ? currentPage + 1 : currentPage - 1;

      // Re-run search
      const matchingCards = cards.filter(card => 
        card.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      const CARDS_PER_PAGE = 5;
      const totalPages = Math.ceil(matchingCards.length / CARDS_PER_PAGE);
      const pageCards = matchingCards.slice(newPage * CARDS_PER_PAGE, (newPage + 1) * CARDS_PER_PAGE);

      let description = '';
      for (const card of pageCards) {
        const owners = [];
        for (const [userId, userDataObj] of Object.entries(userData)) {
          const owned = userDataObj.inventory.filter(entry => {
            const cardId = entry.card_id || entry.cardId;
            return cardId === card.id;
          });
          if (owned.length > 0) {
            const instanceIds = owned.map(e => e.instance_id).filter(Boolean).join(', ');
            owners.push(`<@${userId}> (${instanceIds})`);
          }
        }

        const ownerText = owners.length > 0 ? owners.join(', ') : 'Unclaimed';
        description += `**${card.name}** - ${card.set}\n└ Owners: ${ownerText}\n\n`;
      }

      const embed = new EmbedBuilder()
        .setColor('#4287f5')
        .setTitle(`🔍 Search Results: "${searchQuery}"`)
        .setDescription(description || 'No cards found.')
        .setFooter({ text: `Page ${newPage + 1}/${totalPages} | ${matchingCards.length} cards found` });

      if (pageCards.length > 0) {
        embed.setThumbnail(pageCards[0].imageUrl);
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`search_prev_${newPage}_${searchQuery}`)
            .setLabel('⬅️ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(newPage === 0),
          new ButtonBuilder()
            .setCustomId(`search_next_${newPage}_${searchQuery}`)
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(newPage >= totalPages - 1)
        );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // Handle pick card selection (btn_pick_0, btn_pick_1, btn_pick_2)
    if (customId.startsWith('btn_pick_')) {
      const index = parseInt(customId.split('_')[2]);
      
      if (!data.pickChoices || data.pickChoices.length === 0) {
        return interaction.reply({ content: '❌ No active pick session. Use `/pick` to start.', ephemeral: true });
      }

      const card = data.pickChoices[index];
      if (!card) {
        return interaction.reply({ content: '❌ Invalid choice.', ephemeral: true });
      }

      const instanceId = generateCardInstanceId();
      data.inventory.push({ cardId: card.id, obtainedAt: now, instance_id: instanceId });
      await addCardToInventory(user.id, card.id, now, instanceId);
      data.pickChoices = [];

      const cardNameParts = card.name.split(' ');
      const cardName = cardNameParts[0];
      const quality = `PSA ${Math.floor(Math.random() * 10) + 1}`;
      
      return interaction.update({ 
        content: `## \u2705 ${cardName}\n**Set:** ${card.set} | **Quality:** ${quality}`,
        files: [card.imageUrl],
        components: []
      });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  const now = Date.now();
  const data = await getUserData(user.id);

  // Safety: no cards loaded
  if ((commandName === 'draw' || commandName === 'pack') && !cards.length) {
    return interaction.reply({
      content: '❌ No cards are configured yet. Ask the admin to upload some images to the Supabase bucket.',
      ephemeral: true
    });
  }

  // -------- /draw --------
  if (commandName === 'draw') {
    const elapsed = now - data.lastDraw;

    if (elapsed < DRAW_COOLDOWN) {
      const remaining = DRAW_COOLDOWN - elapsed;
      return interaction.reply({
        content: `⏳ You can draw again in **${msToNice(remaining)}**.`,
        ephemeral: true
      });
    }

    const card = randomCard();
    if (!card) {
      return interaction.reply('❌ No cards available.');
    }

    const instanceId = generateCardInstanceId();
    data.inventory.push({ cardId: card.id, obtainedAt: now, instance_id: instanceId });
    data.lastDraw = now;
    await addCardToInventory(user.id, card.id, now, instanceId);
    await saveUserCooldowns(user.id, data);

    // Defer reply to show "thinking" state
    await interaction.deferReply();

    const cardNameParts = card.name.split(' ');
    const cardName = cardNameParts[0];
    const quality = `PSA ${Math.floor(Math.random() * 10) + 1}`;

    return interaction.editReply({
      content: `## ${cardName}\n**Set:** ${card.set} | **Quality:** ${quality}`,
      files: [card.imageUrl]
    });
  }

  // -------- /pack --------
  if (commandName === 'pack') {
    const elapsed = now - data.lastPack;

    if (elapsed < PACK_COOLDOWN) {
      const remaining = PACK_COOLDOWN - elapsed;
      return interaction.reply({
        content: `⏳ You can open another pack in **${msToNice(remaining)}**.`,
        ephemeral: true
      });
    }

    const packSize = 5;
    const pulled = [];

    for (let i = 0; i < packSize; i++) {
      const card = randomCard();
      if (!card) break;
      const instanceId = generateCardInstanceId();
      pulled.push(card);
      data.inventory.push({ cardId: card.id, obtainedAt: now, instance_id: instanceId });
      await addCardToInventory(user.id, card.id, now, instanceId);
    }

    data.lastPack = now;
    await saveUserCooldowns(user.id, data);

    if (!pulled.length) {
      return interaction.reply('❌ No cards available for pack.');
    }

    const summary = pulled
      .map(c => `- **${c.name}** (${c.rarity})`)
      .join('\n');

    return interaction.reply(
      `🃏 You opened a pack and got:\n${summary}`
    );
  }

  // -------- /inventory --------
  if (commandName === 'inventory') {
    const text = formatInventory(data.inventory);
    return interaction.reply(text);
  }

  // -------- /binder --------
  if (commandName === 'binder') {
    const page = 0;
    const { embed, totalPages } = formatBinderEmbed(data.inventory, page);
    
    if (totalPages <= 1) {
      return interaction.reply({ embeds: [embed] });
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('binder_prev_0')
          .setLabel('⬅️ Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('binder_next_0')
          .setLabel('Next ➡️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(totalPages === 1)
      );

    return interaction.reply({ embeds: [embed], components: [row] });
  }

  // -------- /trash --------
  if (commandName === 'trash') {
    const index = interaction.options.getInteger('index');

    if (index < 0 || index >= data.inventory.length) {
      return interaction.reply({
        content: '❌ Invalid index. Use `/inventory` to see valid indices.',
        ephemeral: true
      });
    }

    const removed = data.inventory.splice(index, 1)[0];
    const card = cards.find(c => c.id === removed.cardId);
    const name = card ? card.name : 'Unknown';

    // Delete from database - need to find the DB row by user_id and card_id and obtained_at
    const { error } = await supabase
      .from('inventory')
      .delete()
      .eq('user_id', user.id)
      .eq('card_id', removed.cardId)
      .eq('obtained_at', removed.obtainedAt)
      .limit(1);

    if (error) {
      console.error('Error deleting from inventory:', error);
    }

    return interaction.reply(
      `🗑️ Trashed **${name}** at index #${index}.`
    );
  }

  // -------- /reset_me --------
  if (commandName === 'reset_me') {
    userData[user.id] = {
      inventory: [],
      lastDraw: 0,
      lastPack: 0,
      lastPick: 0
    };

    // Clear database inventory
    const { error: invError } = await supabase
      .from('inventory')
      .delete()
      .eq('user_id', user.id);

    if (invError) {
      console.error('Error clearing inventory:', invError);
    }

    // Reset user cooldowns in database
    const { error: userError } = await supabase
      .from('users')
      .upsert({
        user_id: user.id,
        last_draw: new Date(0).toISOString(),
        last_pack: new Date(0).toISOString(),
        last_pick: new Date(0).toISOString()
      }, { onConflict: 'user_id' });

    if (userError) {
      console.error('Error resetting user:', userError);
    }

    return interaction.reply('✅ Your data has been reset (testing only).');
  }

  // -------- /menu --------
  if (commandName === 'menu') {
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('btn_draw')
          .setLabel('🎴 Draw Card')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('btn_pack')
          .setLabel('📦 Open Pack')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('btn_inventory')
          .setLabel('📋 Inventory')
          .setStyle(ButtonStyle.Secondary)
      );

    return interaction.reply({
      content: '🎮 **Card Game Menu**\nClick a button to play!',
      components: [row]
    });
  }

  // -------- /search --------
  if (commandName === 'search') {
    const searchQuery = interaction.options.getString('name').toLowerCase();
    const page = 0;

    // Search through all cards
    const matchingCards = cards.filter(card => 
      card.name.toLowerCase().includes(searchQuery)
    );

    if (matchingCards.length === 0) {
      return interaction.reply({
        content: `❌ No cards found matching "${searchQuery}".`,
        ephemeral: true
      });
    }

    await interaction.deferReply();

    // Build paginated embed with ownership info
    const CARDS_PER_PAGE = 5;
    const totalPages = Math.ceil(matchingCards.length / CARDS_PER_PAGE);
    const pageCards = matchingCards.slice(page * CARDS_PER_PAGE, (page + 1) * CARDS_PER_PAGE);

    let description = '';
    for (const card of pageCards) {
      // Search all loaded user inventories for this card
      const owners = [];
      for (const [userId, userDataObj] of Object.entries(userData)) {
        const owned = userDataObj.inventory.filter(entry => {
          const cardId = entry.card_id || entry.cardId;
          return cardId === card.id;
        });
        if (owned.length > 0) {
          const instanceIds = owned.map(e => e.instance_id).filter(Boolean).join(', ');
          owners.push(`<@${userId}> (${instanceIds})`);
        }
      }

      const ownerText = owners.length > 0 ? owners.join(', ') : 'Unclaimed';
      description += `**${card.name}** - ${card.set}\n└ Owners: ${ownerText}\n\n`;
    }

    const embed = new EmbedBuilder()
      .setColor('#4287f5')
      .setTitle(`🔍 Search Results: "${searchQuery}"`)
      .setDescription(description || 'No cards found.')
      .setFooter({ text: `Page ${page + 1}/${totalPages} | ${matchingCards.length} cards found` });

    // Add first card image as thumbnail
    if (pageCards.length > 0) {
      embed.setThumbnail(pageCards[0].imageUrl);
    }

    // Add pagination buttons if needed
    if (totalPages > 1) {
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`search_prev_${page}_${searchQuery}`)
            .setLabel('⬅️ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`search_next_${page}_${searchQuery}`)
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(totalPages === 1)
        );

      return interaction.editReply({ embeds: [embed], components: [row] });
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // -------- /view --------
  if (commandName === 'view') {
    const instanceId = interaction.options.getString('card');

    // Find the card in user's inventory
    const cardEntry = data.inventory.find(entry => {
      const entryInstanceId = entry.instance_id || entry.instanceId;
      return entryInstanceId === instanceId;
    });

    if (!cardEntry) {
      return interaction.reply({
        content: `❌ You don't have a card with ID \`${instanceId}\`. Check your inventory.`,
        ephemeral: true
      });
    }

    const cardId = cardEntry.card_id || cardEntry.cardId;
    const card = cardMap.get(cardId) || cards.find(c => c.id === cardId);

    if (!card) {
      return interaction.reply({
        content: `❌ Card data not found for \`${instanceId}\`.`,
        ephemeral: true
      });
    }

    await interaction.deferReply();

    const cardNameParts = card.name.split(' ');
    const cardName = cardNameParts[0];
    const quality = `PSA ${Math.floor(Math.random() * 10) + 1}`;
    const obtainedDate = new Date(cardEntry.obtained_at || cardEntry.obtainedAt).toLocaleDateString();

    return interaction.editReply({
      content: 
        `## ${cardName}\n` +
        `**Set:** ${card.set}\n` +
        `**Quality:** ${quality}\n` +
        `**Owner:** \`${instanceId}\`\n` +
        `**Obtained:** ${obtainedDate}`,
      files: [card.imageUrl]
    });
  }

  // -------- /trade --------
  if (commandName === 'trade') {
    const instanceId = interaction.options.getString('card');
    const targetUser = interaction.options.getUser('trainer');

    // Check if trading with self
    if (targetUser.id === user.id) {
      return interaction.reply({
        content: '❌ You cannot trade with yourself!',
        ephemeral: true
      });
    }

    // Check if bot
    if (targetUser.bot) {
      return interaction.reply({
        content: '❌ You cannot trade with bots!',
        ephemeral: true
      });
    }

    // Find the card in sender's inventory
    const cardIndex = data.inventory.findIndex(entry => {
      const entryInstanceId = entry.instance_id || entry.instanceId;
      return entryInstanceId === instanceId;
    });

    if (cardIndex === -1) {
      return interaction.reply({
        content: `❌ You don't have a card with ID \`${instanceId}\`. Check your inventory.`,
        ephemeral: true
      });
    }

    const cardEntry = data.inventory[cardIndex];
    const cardId = cardEntry.card_id || cardEntry.cardId;
    const card = cardMap.get(cardId) || cards.find(c => c.id === cardId);
    const cardName = card ? card.name : 'Unknown';

    // Create confirmation buttons
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`trade_accept_${user.id}_${targetUser.id}_${instanceId}`)
          .setLabel('✅ Accept')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`trade_decline_${user.id}_${targetUser.id}_${instanceId}`)
          .setLabel('❌ Decline')
          .setStyle(ButtonStyle.Danger)
      );

    return interaction.reply({
      content: `📦 <@${user.id}> wants to trade **${cardName}** (\`${instanceId}\`) to <@${targetUser.id}>\n\n<@${targetUser.id}>, do you accept this trade?`,
      components: [row]
    });
  }

  // -------- /help --------
  if (commandName === 'help') {
    return interaction.reply({
      content: 
        '**Card Game Commands:**\n\n' +
        '**Text Commands:**\n' +
        '`kd` or `kd draw` - Draw a card (5 min cooldown)\n' +
        '`kd pack` or `kd p` - Open a pack of 5 cards (10 min cooldown)\n' +
        '`pick` or `pk` - Pick 1 from 3 cards (30 min cooldown)\n' +
        '`kd inventory`, `kd inv`, or `kd i` - View your collection\n' +
        '`binder`, `kd binder`, or `kd b` - View organized binder\n' +
        '`help` or `kd help` - Show this help\n\n' +
        '**Slash Commands:**\n' +
        '`/draw` - Draw a card\n' +
        '`/pack` - Open a pack\n' +
        '`/pick` - Pick from 3 cards\n' +
        '`/inventory` - View your collection\n' +
        '`/binder` - View organized binder\n' +
        '`/menu` - Interactive button menu\n' +
        '`/search <name>` - Search for cards by name\n' +
        '`/view <card>` - View a specific card\n' +
        '`/trade <card> <@trainer>` - Trade a card to another trainer\n' +
        '`/trash <index>` - Remove a card\n' +
        '`/reset_me` - Reset your data (testing)\n' +
        '`/help` - Show this help',
      ephemeral: true
    });
  }

  // -------- /pick --------
  if (commandName === 'pick') {
    const elapsed = now - data.lastPick;

    if (elapsed < PICK_COOLDOWN) {
      const remaining = PICK_COOLDOWN - elapsed;
      return interaction.reply({
        content: `⏳ You can pick again in **${msToNice(remaining)}**.`,
        ephemeral: true
      });
    }

    // Draw 3 random cards
    const choices = [];
    for (let i = 0; i < 3; i++) {
      const card = randomCard();
      if (!card) break;
      choices.push(card);
    }

    if (choices.length < 3) {
      return interaction.reply('❌ Not enough cards available.');
    }

    data.lastPick = now;
    data.pickChoices = choices;

    await interaction.deferReply();

    // Combine the 3 images horizontally
    const combinedImageBuffer = await combineCardImages(
      choices[0].imageUrl,
      choices[1].imageUrl,
      choices[2].imageUrl
    );

    if (!combinedImageBuffer) {
      return interaction.editReply('❌ Failed to load card images.');
    }

    const attachment = new AttachmentBuilder(combinedImageBuffer, { name: 'cards.png' });

    // Create card info text
    const cardInfo = choices.map((card, i) => {
      const cardNameParts = card.name.split(' ');
      const cardName = cardNameParts[0];
      return `**${['1️⃣', '2️⃣', '3️⃣'][i]} ${cardName}** - Set: ${card.set}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🎴 Pick one card to keep:')
      .setDescription(cardInfo)
      .setImage('attachment://cards.png')
      .setColor(0x5865F2);

    // Create buttons for selection
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('btn_pick_0')
          .setLabel('1️⃣')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('btn_pick_1')
          .setLabel('2️⃣')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('btn_pick_2')
          .setLabel('3️⃣')
          .setStyle(ButtonStyle.Primary)
      );

    return interaction.editReply({
      content: content,
      files: [attachment],
      components: [row]
    });
  }
});

// ------------------- STARTUP -------------------
(async () => {
  await loadCardsFromSupabase();  // load card list first
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
