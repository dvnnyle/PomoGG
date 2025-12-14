// utils.js

// Format milliseconds to nice time string
function msToNice(ms) {
  if (ms <= 0) return 'now';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const h = hours % 24;
    return `${days}d ${h}h`;
  } else if (hours > 0) {
    const m = minutes % 60;
    return `${hours}h ${m}m`;
  } else if (minutes > 0) {
    const s = seconds % 60;
    return `${minutes}m ${s}s`;
  } else {
    return `${seconds}s`;
  }
}

// Format inventory (short list format)
function formatInventory(inventory, start = 0, count = 10) {
  if (!inventory || inventory.length === 0) {
    return 'Your inventory is empty.';
  }
  
  const end = Math.min(start + count, inventory.length);
  const items = inventory.slice(start, end);
  
  const lines = items.map((item, i) => {
    const quality = Math.floor(Math.random() * 10) + 1;
    return `${start + i + 1}. **${item.cardName}** (${item.cardSet}) • Quality: ${quality}`;
  });
  
  return lines.join('\n');
}

// Format binder embed with pagination
function formatBinderEmbed(binder, page = 1, pageSize = 10, cardMap, formatCardName) {
  if (!binder || binder.length === 0) {
    return {
      title: '📖 Your Binder',
      description: 'Your binder is empty.',
      footer: 'Page 1/1',
      isEmpty: true
    };
  }
  
  const totalPages = Math.ceil(binder.length / pageSize);
  const currentPage = Math.max(1, Math.min(page, totalPages));
  
  const start = (currentPage - 1) * pageSize;
  const end = Math.min(start + pageSize, binder.length);
  
  const items = binder.slice(start, end).map((item, idx) => {
    const quality = Math.floor(Math.random() * 10) + 1;
    const actualIndex = start + idx;
    
    // Get card details from cardMap
    const cardId = item.card_id || item.cardId;
    const card = cardMap?.get(cardId);
    const cardName = card ? formatCardName(card.name) : 'Unknown Card';
    const cardSet = card ? card.set : 'Unknown Set';
    
    return {
      index: actualIndex,
      text: `#${actualIndex + 1} • **${cardName}** (${cardSet}) • Quality: ${quality}`
    };
  });
  
  const description = items.map(item => item.text).join('\n');
  
  return {
    title: '📖 Your Binder',
    description: description || 'No cards on this page.',
    footer: `Page ${currentPage}/${totalPages} • ${binder.length} total cards`,
    currentPage,
    totalPages,
    isEmpty: false
  };
}

module.exports = {
  msToNice,
  formatInventory,
  formatBinderEmbed
};
