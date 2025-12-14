// database.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

    if (userError && userError.code !== 'PGRST116') {
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

// Server configuration (guild_id -> channel_id)
const serverConfig = new Map();

// Admin configuration (user_id -> boolean)
const adminUsers = new Set();

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

// Load admins from database
async function loadAdmins() {
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('*');
    
    if (error) {
      console.error('Error loading admins:', error);
      return;
    }
    
    if (data) {
      adminUsers.clear();
      data.forEach(admin => {
        adminUsers.add(admin.user_id);
      });
      console.log(`Loaded ${data.length} admin users`);
    }
  } catch (error) {
    console.error('Error in loadAdmins:', error);
  }
}

// Add admin to database
async function addAdmin(userId) {
  try {
    adminUsers.add(userId);
    
    await supabase
      .from('admins')
      .upsert({
        user_id: userId
      });
    
    return true;
  } catch (error) {
    console.error('Error adding admin:', error);
    return false;
  }
}

// Remove admin from database
async function removeAdmin(userId) {
  try {
    adminUsers.delete(userId);
    
    await supabase
      .from('admins')
      .delete()
      .eq('user_id', userId);
    
    return true;
  } catch (error) {
    console.error('Error removing admin:', error);
    return false;
  }
}

// Check if user is admin
function isAdmin(userId) {
  return adminUsers.has(userId);
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

module.exports = {
  supabase,
  userData,
  getUserData,
  saveUserCooldowns,
  addCardToInventory,
  loadServerConfigs,
  loadAdmins,
  addAdmin,
  removeAdmin,
  isAdmin,
  setGuildChannel,
  isAllowedChannel
};
