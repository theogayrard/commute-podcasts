export interface SoundClip {
  id: string;
  name: string;
  kind: 'music' | 'transition' | 'ambience';
  description: string;
  tags: string[];
  seconds: number;
  artist: string;
  originalTitle: string;
  sourceUrl: string;
  license: 'CC0-1.0';
}

const piano = { artist: 'The Cynic Project / cynicmusic', originalTitle: 'Calm Piano 1 (Vaporware)', sourceUrl: 'https://opengameart.org/content/calm-piano-1-vaporware', license: 'CC0-1.0' as const };
const exploration = { artist: 'Cleyton Kauffman', originalTitle: 'Exploration Theme', sourceUrl: 'https://opengameart.org/content/exploration-theme', license: 'CC0-1.0' as const };
const discovery = { artist: 'Centurion_of_war', originalTitle: 'Happy moments', sourceUrl: 'https://opengameart.org/content/happy-moments', license: 'CC0-1.0' as const };

// Deliberately small, local, instrumental collection. See assets/sounds/SOURCES.json
// for exact source downloads, excerpts, checksums and preparation settings.
export const SOUND_LIBRARY: SoundClip[] = [
  { ...piano, id: 'warm-piano', name: 'A little further', kind: 'music', description: 'Gentle piano and warm pads for thoughtful conversations.', tags: ['warm', 'reflective', 'human', 'history', 'wellbeing'], seconds: 24 },
  { ...exploration, id: 'quiet-discovery', name: 'Beyond the horizon', kind: 'music', description: 'Spacious synth and piano for curious, exploratory stories.', tags: ['curious', 'science', 'space', 'technology', 'ocean'], seconds: 24 },
  { ...discovery, id: 'bright-ideas', name: 'Small discoveries', kind: 'music', description: 'A light piano melody for optimistic, everyday discoveries.', tags: ['bright', 'hopeful', 'playful', 'culture', 'everyday'], seconds: 24 },
  { ...piano, id: 'piano-bridge', name: 'A thoughtful pause', kind: 'transition', description: 'A brief piano passage between ideas.', tags: ['warm', 'reflective'], seconds: 4 },
  { ...exploration, id: 'discovery-bridge', name: 'Another perspective', kind: 'transition', description: 'A soft electronic passage to introduce a new angle.', tags: ['curious', 'science', 'technology'], seconds: 4 },
  { ...discovery, id: 'bright-bridge', name: 'On we go', kind: 'transition', description: 'A light piano passage for an upbeat change of subject.', tags: ['bright', 'hopeful'], seconds: 4 },
  { id: 'forest', name: 'Among the trees', kind: 'ambience', description: 'A natural forest field recording. Use for a scene set in woodland.', tags: ['forest', 'woodland', 'nature', 'birds'], seconds: 24, artist: 'deadrobotmusic', originalTitle: 'Forest Ambience 1', sourceUrl: 'https://freesound.org/people/deadrobotmusic/sounds/687053/', license: 'CC0-1.0' },
  { id: 'rain', name: 'Gentle rainfall', kind: 'ambience', description: 'Rain falling in the woods. Use for a scene involving rain.', tags: ['rain', 'weather', 'rainfall'], seconds: 24, artist: 'rasunter255', originalTitle: 'gentle rainfall.wav', sourceUrl: 'https://freesound.org/people/rasunter255/sounds/416227/', license: 'CC0-1.0' },
  { id: 'ocean', name: 'At the water’s edge', kind: 'ambience', description: 'Calm waves on the shore. Use for a coastal or ocean scene.', tags: ['ocean', 'sea', 'beach', 'coast', 'waves'], seconds: 24, artist: 'SamsterBirdies', originalTitle: 'Calm ocean waves', sourceUrl: 'https://freesound.org/people/SamsterBirdies/sounds/578524/', license: 'CC0-1.0' },
  { id: 'fire', name: 'By the fireside', kind: 'ambience', description: 'A gently crackling fireplace. Use for a fireside scene.', tags: ['fireplace', 'campfire', 'fire', 'hearth'], seconds: 24, artist: 'RyanKingArt', originalTitle: 'Fireplace Fire Crackling', sourceUrl: 'https://freesound.org/people/RyanKingArt/sounds/717579/', license: 'CC0-1.0' },
];

export const soundClip = (id: string) => SOUND_LIBRARY.find(clip => clip.id === id);
export const themeBridge = (themeId: string) => ({ 'warm-piano': 'piano-bridge', 'quiet-discovery': 'discovery-bridge', 'bright-ideas': 'bright-bridge' })[themeId] || 'piano-bridge';
