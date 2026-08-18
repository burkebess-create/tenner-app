// Shared: on any /gifts/[category].html page, look for an element with
// data-category. If present, call the Supabase RPC to fetch the top items
// aggregated across all public Tenner lists for that category. If the RPC
// returns >= 30 lists worth of data, replace the hardcoded picks with the
// live aggregated items. Otherwise leave the hardcoded fallback in place.
(function() {
  var SUPABASE_URL = 'https://bbjpvlmkhvggtwyvpzrq.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_jeeTdNoqIJXBtx_1W1TscQ_cnRAcwHx';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function amazonUrl(item, suffix) {
    var q = String(item) + (suffix ? (' ' + suffix) : ' gift ideas');
    return 'https://www.amazon.com/s?k=' + encodeURIComponent(q.trim()).replace(/%20/g, '+') + '&tag=tenner09-20';
  }

  function renderPicks(container, items, suffix) {
    container.innerHTML = items.map(function(entry, i) {
      var name = entry.item;
      var count = entry.count;
      return '<div class="pick"><div class="rank">' + (i + 1) + '</div>'
        + '<div class="body">'
        +   '<div class="title">' + escapeHtml(name) + '</div>'
        +   '<div class="desc">Chosen by ' + count + ' Tenner user' + (count === 1 ? '' : 's') + '. Tap Shop to see gift ideas built around this pick.</div>'
        + '</div>'
        + '<a class="shop" href="' + amazonUrl(name, suffix) + '" target="_blank" rel="noopener sponsored nofollow">Shop →</a>'
        + '</div>';
    }).join('');
  }

  async function boot() {
    var container = document.getElementById('picks-container');
    if (!container) return;
    var category = container.getAttribute('data-category');
    var suffix = container.getAttribute('data-suffix') || '';
    if (!category || typeof supabase === 'undefined') return;

    var srcTag = document.getElementById('dynamic-source');
    try {
      var sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      var res = await sb.rpc('get_top_items_for_category', { cat: category, max_items: 12, min_lists: 30 });
      if (res.error || !res.data) {
        if (srcTag) srcTag.style.display = 'none';
        return;
      }
      var items = res.data.items;
      var totalLists = res.data.total_lists || 0;
      if (Array.isArray(items) && items.length > 0) {
        renderPicks(container, items, suffix);
        if (srcTag) {
          srcTag.textContent = '✨ These picks are live — ranked by ' + totalLists + ' Tenner ' + (totalLists === 1 ? 'list' : 'lists') + ' in this category.';
          srcTag.style.display = 'block';
        }
      } else {
        // Below threshold — keep hardcoded picks, hide loading indicator
        if (srcTag) srcTag.style.display = 'none';
      }
    } catch(e) {
      console.warn('Dynamic picks failed', e);
      if (srcTag) srcTag.style.display = 'none';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
