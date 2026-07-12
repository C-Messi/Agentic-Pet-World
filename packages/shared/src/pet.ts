import { z } from 'zod';

import { IdentifierSchema } from './protocol.js';

export const PET_ANIMATION_NAMES = [
  'idle',
  'walk',
  'sit',
  'sleep',
  'happy',
  'curious',
  'confused',
] as const;

const HexColorSchema = z.custom<`#${string}`>(
  (value) => typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value),
);
const PersonalityScoreSchema = z.number().finite().min(0).max(1);
const NonEmptyTextSchema = z.string().trim().min(1);

const PaletteSchema = z
  .object({
    primary: HexColorSchema,
    secondary: HexColorSchema,
    accent: HexColorSchema,
  })
  .strict();

const PersonalitySchema = z
  .object({
    curiosity: PersonalityScoreSchema,
    sociability: PersonalityScoreSchema,
    playfulness: PersonalityScoreSchema,
    creativity: PersonalityScoreSchema,
  })
  .strict();

const VoiceSchema = z
  .object({
    style: NonEmptyTextSchema.max(80),
    catchphrases: z.array(NonEmptyTextSchema).max(3),
  })
  .strict()
  .superRefine(({ catchphrases }, context) => {
    const seen = new Set<string>();

    for (const [index, catchphrase] of catchphrases.entries()) {
      if (seen.has(catchphrase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate catchphrase: ${catchphrase}`,
          path: ['catchphrases', index],
        });
      }
      seen.add(catchphrase);
    }
  });

export const PetDefinitionSchema = z
  .object({
    schemaVersion: z.literal('pet-definition.v1'),
    id: IdentifierSchema,
    displayName: z.string().trim().min(1).max(24),
    source: z.enum(['player-pet', 'resident']),
    species: NonEmptyTextSchema.max(32),
    spriteId: IdentifierSchema,
    palette: PaletteSchema,
    personality: PersonalitySchema,
    voice: VoiceSchema,
    interests: z.array(NonEmptyTextSchema).max(5),
    publicBio: NonEmptyTextSchema.max(160),
  })
  .strict()
  .superRefine(({ interests }, context) => {
    const seen = new Set<string>();

    for (const [index, interest] of interests.entries()) {
      if (seen.has(interest)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate interest: ${interest}`,
          path: ['interests', index],
        });
      }
      seen.add(interest);
    }
  });
export type PetDefinition = z.infer<typeof PetDefinitionSchema>;

const AnimationFramesSchema = z
  .tuple([
    z.number().int().min(0).max(27),
    z.number().int().min(0).max(27),
    z.number().int().min(0).max(27),
    z.number().int().min(0).max(27),
  ])
  .superRefine((frames, context) => {
    const seen = new Set<number>();

    for (const [index, frame] of frames.entries()) {
      if (seen.has(frame)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate animation frame: ${frame}`,
          path: [index],
        });
      }
      seen.add(frame);
    }
  });

const AnimationSchema = z
  .object({
    frames: AnimationFramesSchema,
    frameRate: z.number().finite().positive(),
  })
  .strict();

const BodySchema = z
  .object({
    width: z.number().finite().min(1).max(32),
    height: z.number().finite().min(1).max(32),
    offsetX: z.number().finite(),
    offsetY: z.number().finite(),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.offsetX < 0 || body.offsetX + body.width > 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Body must fit horizontally inside the frame',
        path: ['offsetX'],
      });
    }
    if (body.offsetY < 0 || body.offsetY + body.height > 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Body must fit vertically inside the frame',
        path: ['offsetY'],
      });
    }
  });

export const PetSpriteManifestSchema = z
  .object({
    schemaVersion: z.literal('pet-sprite.v1'),
    pixelArt: z.literal(true),
    image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/),
    frame: z.object({ width: z.literal(32), height: z.literal(32) }).strict(),
    columns: z.literal(4),
    rows: z.literal(7),
    anchor: z.object({ x: z.literal(0.5), y: z.literal(0.78) }).strict(),
    body: BodySchema,
    animations: z
      .object({
        idle: AnimationSchema,
        walk: AnimationSchema,
        sit: AnimationSchema,
        sleep: AnimationSchema,
        happy: AnimationSchema,
        curious: AnimationSchema,
        confused: AnimationSchema,
      })
      .strict(),
  })
  .strict();
export type PetSpriteManifest = z.infer<typeof PetSpriteManifestSchema>;
