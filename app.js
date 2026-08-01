// Genre abbreviations that won't substring-match their channel names.
const GENRE_SYNONYMS = {
  dnb: "drum and bass",
  "d&b": "drum and bass",
  edm: "electronic dance music",
  lofi: "lo-fi",
};

// Static: this fork has no backend, so there's nothing to fetch these from.
const NETWORKS = [
  { slug: "somafm", display_name: "SOMAFM.COM" },
  { slug: "radiobrowser", display_name: "RADIO-BROWSER.INFO" },
  { slug: "yle", display_name: "YLE.FI" },
];

const RB_HOSTS = [
  "all.api.radio-browser.info", // DNS round-robin across all servers
  "de1.api.radio-browser.info",
  "nl1.api.radio-browser.info",
  "at1.api.radio-browser.info",
];

const STORAGE_KEYS = {
  favourites: "signal-radio:favourites",
  custom: "signal-radio:custom-channels",
};

function loadFromStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // storage disabled/full -- favourites just won't persist this session
  }
}

const loadFavourites = () => loadFromStorage(STORAGE_KEYS.favourites);
const saveFavourites = (favs) => saveToStorage(STORAGE_KEYS.favourites, favs);
const loadCustomChannels = () => loadFromStorage(STORAGE_KEYS.custom);
const saveCustomChannels = (items) => saveToStorage(STORAGE_KEYS.custom, items);

async function fetchSomaFMChannels() {
  try {
    const res = await fetch("https://somafm.com/channels.json");
    if (!res.ok) return [];
    const data = await res.json();
    return (data.channels || []).map((c) => ({
      id: c.id,
      name: c.title,
      key: c.id,
      item_type: "radio",
      network: "somafm",
      description: c.description,
      playlist_url: c.playlists && c.playlists[0] ? c.playlists[0].url : null,
    }));
  } catch (e) {
    return [];
  }
}

// Returns 'pls' or 'm3u' if the URL looks like a playlist wrapper file, else null.
// .m3u8 is HLS -- pass straight to <audio>, no parsing needed.
function playlistFormat(url) {
  const lowered = url.split("?")[0].toLowerCase();
  if (lowered.endsWith(".pls")) return "pls";
  if (lowered.endsWith(".m3u")) return "m3u";
  return null;
}

// Extracts every stream URL from playlist file content, in the order the
// playlist itself ranks them -- a .pls often lists several mirrors.
function parsePlaylistUrls(content, fmt) {
  if (fmt === "pls") {
    const entries = [];
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();
      const match = /^file(\d+)$/i.exec(key);
      if (match && value) entries.push([parseInt(match[1], 10), value]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    return entries.map(([, url]) => url);
  }
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function titleCase(s) {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// Typo-tolerant fallback for when a plain substring search finds nothing --
// e.g. "elctro" or "jaz". Only runs on that near-miss case, so re-indexing
// per call is cheap at this catalog size.
function fuzzySearch(source, query) {
  const fuse = new Fuse(source, {
    keys: [
      { name: "name", weight: 0.7 },
      { name: "description", weight: 0.3 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
  });
  return fuse.search(query).map((r) => r.item);
}

function radioApp() {
  return {
    networks: NETWORKS,
    channels: [],
    favouriteItems: [],
    category: "all_networks",
    query: "",
    loading: true,
    nowPlaying: null,
    pendingItem: null,
    nowPlayingTrack: null,
    isPlaying: false,
    volume: 70,
    errorMessage: "",
    helpOpen: false,
    browseOpen: false,
    browseQuery: "",
    browseTag: "",
    browseResults: [],
    browsing: false,

    _resolvedCache: new Map(),
    _candidates: [],
    _candidateIndex: 0,
    _trackPollTimer: null,
    _errorTimer: null,

    async init() {
      try {
        const [somafm, radiobrowser, yle] = await Promise.all([
          fetchSomaFMChannels(),
          fetch("data/radiobrowser.json").then((r) => r.json()),
          fetch("data/yle.json").then((r) => r.json()),
        ]);
        const catalog = [...somafm, ...radiobrowser, ...yle];

        const existingKeys = new Set(catalog.map((c) => c.key));
        for (const custom of loadCustomChannels()) {
          if (!existingKeys.has(custom.key)) {
            catalog.push(custom);
            existingKeys.add(custom.key);
          }
        }

        this.channels = catalog;
        this.favouriteItems = this.resolveFavourites(loadFavourites());
      } catch (e) {
        this.flashError("Couldn't reach the station catalog.");
      } finally {
        this.loading = false;
        this.$refs.audio.volume = this.volume / 100;
      }
    },

    resolveFavourites(favs) {
      const byKey = new Map(this.channels.map((c) => [`${c.network}:${c.key}`, c]));
      return favs.map(
        (f) =>
          byKey.get(`${f.network}:${f.key}`) || {
            id: 0,
            name: f.name,
            key: f.key,
            item_type: "radio",
            network: f.network,
          }
      );
    },

    toggleFavouritesFilter() {
      this.category = this.category === "favourite" ? "all_networks" : "favourite";
    },

    networkDisplay(slug) {
      const net = this.networks.find((n) => n.slug === slug);
      return net ? net.display_name : slug.toUpperCase();
    },

    filteredChannels() {
      const source = this.category === "favourite" ? this.favouriteItems : this.channels;

      const q = this.query.trim().toLowerCase();
      if (!q) return source;
      const expanded = GENRE_SYNONYMS[q];
      const matchesText = (text) => text.includes(q) || (expanded && text.includes(expanded));

      const byName = source.filter((c) => matchesText(c.name.toLowerCase()));
      if (byName.length > 0) return byName;

      const byDescription = source.filter((c) => c.description && matchesText(c.description.toLowerCase()));
      if (byDescription.length > 0) return byDescription;

      return fuzzySearch(source, expanded ? `${this.query.trim()} ${expanded}` : this.query.trim());
    },

    emptyMessage() {
      const q = this.query.trim();
      if (q) return `No stations match “${q}”.`;
      if (this.category === "favourite") return "No favourites yet — press ★ on a station to keep it here.";
      return "No stations in this category.";
    },

    isFavourite(key) {
      return this.favouriteItems.some((f) => f.key === key);
    },

    isNowPlaying(item) {
      return !!this.nowPlaying && this.nowPlaying.key === item.key && this.nowPlaying.network === item.network;
    },

    nowPlayingLabel() {
      if (!this.nowPlaying) return "Nothing tuned in";
      return `${this.nowPlaying.name} — ${this.networkDisplay(this.nowPlaying.network)}`;
    },

    toggleFavourite(item) {
      if (this.isFavourite(item.key)) {
        saveFavourites(loadFavourites().filter((f) => f.key !== item.key));
        this.favouriteItems = this.favouriteItems.filter((f) => f.key !== item.key);
      } else {
        const favs = loadFavourites();
        favs.push({ key: item.key, network: item.network, name: item.name });
        saveFavourites(favs);
        this.favouriteItems.push(item);
      }
    },

    // Fetches (and caches) the ordered list of playable candidate URLs for an
    // item: parses .pls/.m3u wrapper files into their mirror list, or just
    // returns the item's own playlist_url unchanged if it's already direct.
    async resolveStreamUrl(item) {
      const url = item.playlist_url;
      if (!url) return [];
      if (this._resolvedCache.has(item.key)) return this._resolvedCache.get(item.key);

      let candidates = [url];
      const fmt = playlistFormat(url);
      if (fmt) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const parsed = parsePlaylistUrls(await res.text(), fmt);
            if (parsed.length) candidates = parsed;
          }
        } catch (e) {
          // fall back to the original url unchanged
        }
      }

      this._resolvedCache.set(item.key, candidates);
      return candidates;
    },

    async play(item) {
      this.pendingItem = item;
      this._candidates = await this.resolveStreamUrl(item);
      if (!this._candidates.length) {
        this.flashError(`No stream available for ${item.name}.`);
        return;
      }
      this._candidateIndex = 0;
      this._playCurrentCandidate(item);
    },

    _playCurrentCandidate(item) {
      const audio = this.$refs.audio;
      audio.src = this._candidates[this._candidateIndex];
      audio.volume = this.volume / 100;
      audio
        .play()
        .then(() => {
          this.isPlaying = true;
          this.nowPlaying = item;
          this.startTrackPolling(item);
        })
        .catch(() => {
          // The <audio> element's `error` event (onAudioError) is the
          // reliable signal for stream failures and drives mirror fallback;
          // this just swallows the play() rejection itself.
        });
    },

    stop() {
      const audio = this.$refs.audio;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      this.isPlaying = false;
      this.stopTrackPolling();
    },

    startTrackPolling(item) {
      this.stopTrackPolling();
      if (item.network !== "somafm") return;
      this.fetchNowPlayingTrack(item);
      this._trackPollTimer = setInterval(() => this.fetchNowPlayingTrack(item), 20000);
    },

    stopTrackPolling() {
      clearInterval(this._trackPollTimer);
      this._trackPollTimer = null;
      this.nowPlayingTrack = null;
    },

    async fetchNowPlayingTrack(item) {
      try {
        const res = await fetch("https://somafm.com/channels.json");
        if (!res.ok) {
          this.nowPlayingTrack = null;
          return;
        }
        const data = await res.json();
        const channel = (data.channels || []).find((c) => c.id === item.key);
        this.nowPlayingTrack = channel && channel.lastPlaying ? { track: channel.lastPlaying } : null;
      } catch (e) {
        this.nowPlayingTrack = null;
      }
    },

    setVolume() {
      this.$refs.audio.volume = this.volume / 100;
    },

    isCustom(item) {
      return item.source === "custom";
    },

    isInCatalog(item) {
      return this.channels.some((c) => c.key === item.key);
    },

    async searchBrowse() {
      if (!this.browseQuery.trim() && !this.browseTag.trim()) return;
      this.browsing = true;
      this.browseResults = [];

      const params = new URLSearchParams({
        limit: "20",
        order: "votes",
        reverse: "true",
        lastcheckok: "1",
        hidebroken: "true",
      });
      if (this.browseQuery.trim()) params.set("name", this.browseQuery.trim());
      if (this.browseTag.trim()) params.set("tag", this.browseTag.trim());

      let stations = null;
      for (const host of RB_HOSTS) {
        try {
          const res = await fetch(`https://${host}/json/stations/search?${params.toString()}`);
          if (!res.ok) continue;
          stations = await res.json();
          break;
        } catch (e) {
          continue;
        }
      }

      this.browsing = false;
      if (!stations) {
        this.flashError("Radio Browser unreachable — try again shortly.");
        return;
      }

      this.browseResults = stations
        .filter((s) => s.url_resolved || s.url)
        .map((s) => {
          const tagLabel = titleCase((s.tags || "").split(",")[0].trim() || "Radio");
          return {
            id: s.stationuuid,
            name: s.name,
            key: s.stationuuid,
            item_type: "radio",
            network: "radiobrowser",
            description: `${tagLabel} · ${s.country || ""}`,
            playlist_url: s.url_resolved || s.url,
          };
        });
    },

    addCustomChannel(item) {
      const saved = { ...item, source: "custom" };
      const custom = loadCustomChannels();
      if (custom.some((c) => c.key === saved.key)) return;
      custom.push(saved);
      saveCustomChannels(custom);
      if (!this.channels.some((c) => c.key === saved.key)) this.channels.push(saved);
    },

    removeCustomChannel(item) {
      const custom = loadCustomChannels();
      const remaining = custom.filter((c) => c.key !== item.key);
      if (remaining.length === custom.length) return;
      saveCustomChannels(remaining);

      this.channels = this.channels.filter((c) => !(c.key === item.key && c.source === "custom"));
      if (this.nowPlaying?.key === item.key) this.stop();
      this.favouriteItems = this.favouriteItems.filter((f) => f.key !== item.key);
      saveFavourites(loadFavourites().filter((f) => f.key !== item.key));
    },

    onAudioError() {
      const failed = this.pendingItem || this.nowPlaying;
      if (!failed) return;

      this._candidateIndex += 1;
      if (this._candidateIndex < this._candidates.length) {
        this._playCurrentCandidate(failed);
        return;
      }

      this.isPlaying = false;
      this.stopTrackPolling();
      this.flashError(`Lost signal — couldn't play ${failed.name}.`);
    },

    flashError(message) {
      this.errorMessage = message;
      clearTimeout(this._errorTimer);
      this._errorTimer = setTimeout(() => {
        this.errorMessage = "";
      }, 4000);
    },
  };
}
