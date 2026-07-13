import { z } from 'zod';

const GraphemeSegmenter = new Intl.Segmenter('en', {
  granularity: 'grapheme',
});

export const ResidentSpeechSchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .refine((value) => graphemeCount(value) <= 80, {
    message: 'Speech must contain at most 80 grapheme clusters',
  });

export const EncounterAnimationSchema = z.enum([
  'curious',
  'happy',
  'sit',
  'confused',
]);

function graphemeCount(value: string): number {
  return Array.from(GraphemeSegmenter.segment(value)).length;
}
