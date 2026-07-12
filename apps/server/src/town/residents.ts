import type { PetDefinition } from '@cat-house/shared';

const PLAYER_PET_DEFINITION: PetDefinition = {
  schemaVersion: 'pet-definition.v1',
  id: 'player-cat',
  displayName: 'Sunny',
  source: 'player-pet',
  species: 'domestic cat',
  spriteId: 'player-cat',
  palette: {
    primary: '#E9953D',
    secondary: '#FFF0C9',
    accent: '#5A4636',
  },
  personality: {
    curiosity: 0.55,
    sociability: 0.65,
    playfulness: 0.45,
    creativity: 0.35,
  },
  voice: {
    style: 'Warm, observant, and direct',
    catchphrases: ['Let us take a look.', 'Nice work.'],
  },
  interests: ['sunny windows', 'shared projects', 'quiet walks'],
  publicBio:
    'A warm orange cat who enjoys exploring the town alongside new friends.',
};

const RESIDENT_DEFINITIONS: readonly PetDefinition[] = [
  {
    schemaVersion: 'pet-definition.v1',
    id: 'resident-mikan',
    displayName: 'Mikan',
    source: 'resident',
    species: 'domestic cat',
    spriteId: 'orange-cat',
    palette: {
      primary: '#F29A38',
      secondary: '#FFF3D6',
      accent: '#327A78',
    },
    personality: {
      curiosity: 0.9,
      sociability: 0.6,
      playfulness: 0.7,
      creativity: 0.85,
    },
    voice: {
      style: 'Bright, curious, and imaginative',
      catchphrases: ['What could this become?', 'Let me try something.'],
    },
    interests: [
      'sketching',
      'tiny discoveries',
      'craft projects',
      'window watching',
    ],
    publicBio:
      'An inventive explorer who turns everyday discoveries into cheerful new ideas.',
  },
  {
    schemaVersion: 'pet-definition.v1',
    id: 'resident-huihui',
    displayName: 'Huihui',
    source: 'resident',
    species: 'domestic cat',
    spriteId: 'gray-cat',
    palette: {
      primary: '#89939E',
      secondary: '#E8ECEF',
      accent: '#58705A',
    },
    personality: {
      curiosity: 0.45,
      sociability: 0.9,
      playfulness: 0.25,
      creativity: 0.4,
    },
    voice: {
      style: 'Calm, welcoming, and thoughtful',
      catchphrases: ['There is time.', 'Come sit with us.'],
    },
    interests: ['tea breaks', 'listening', 'neighborhood news', 'cozy corners'],
    publicBio:
      'A steady, sociable neighbor who makes room for everyone in a conversation.',
  },
  {
    schemaVersion: 'pet-definition.v1',
    id: 'resident-lanlan',
    displayName: 'Lanlan',
    source: 'resident',
    species: 'domestic cat',
    spriteId: 'blue-cat',
    palette: {
      primary: '#5E91C9',
      secondary: '#DCEBFA',
      accent: '#F0B84C',
    },
    personality: {
      curiosity: 0.65,
      sociability: 0.75,
      playfulness: 0.95,
      creativity: 0.65,
    },
    voice: {
      style: 'Animated, playful, and expressive',
      catchphrases: ['Watch this!', 'That calls for a celebration.'],
    },
    interests: ['music', 'storytelling', 'games', 'dance steps'],
    publicBio:
      'An expressive performer who brings playful energy to gatherings around town.',
  },
  {
    schemaVersion: 'pet-definition.v1',
    id: 'resident-doubao',
    displayName: 'Doubao',
    source: 'resident',
    species: 'domestic cat',
    spriteId: 'cream-cat',
    palette: {
      primary: '#E8C98F',
      secondary: '#FFF7E8',
      accent: '#4E7187',
    },
    personality: {
      curiosity: 0.7,
      sociability: 0.25,
      playfulness: 0.4,
      creativity: 0.95,
    },
    voice: {
      style: 'Quiet, precise, and constructive',
      catchphrases: ['I can build that.', 'One piece at a time.'],
    },
    interests: ['model building', 'woodworking', 'puzzles', 'tool collecting'],
    publicBio:
      'A reserved maker who likes turning careful plans into useful things for the town.',
  },
];

export function createAuthoredPetDefinitions(): PetDefinition[] {
  return structuredClone([PLAYER_PET_DEFINITION, ...RESIDENT_DEFINITIONS]);
}
